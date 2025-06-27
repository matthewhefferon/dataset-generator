import { NextRequest, NextResponse } from 'next/server';
import { OpenAI } from 'openai';
import { generateSpecPrompt, GenerateSpecPromptParams } from '@/lib/spec-prompts';
import { DataFactory } from '@/lib/data-factory';

const openai = new OpenAI({
  apiKey: process.env.LITELLM_MASTER_KEY || 'sk-1234',
  baseURL: process.env.LLM_ENDPOINT || 'http://localhost:4000',
});

export async function POST(req: Request) {
  try {
    const {
      businessType,
      rowCount,
      context,
      isPreview,
      timeRange,
      growthPattern,
      variationLevel,
      granularity,
      schemaType,
    }: GenerateSpecPromptParams & {
      rowCount: number;
      isPreview?: boolean;
      schemaType?: string;
    } = await req.json();

    // Validate required fields
    if (!businessType) {
      return NextResponse.json({ error: 'Missing required field: businessType' }, { status: 400 });
    }

    // 1. Generate the spec from the LLM
    const prompt = generateSpecPrompt({
      businessType,
      schemaType,
      context,
      timeRange,
      growthPattern,
      variationLevel,
      granularity,
    });

    // Estimate token usage for cost visibility
    const promptLengthInTokens = Math.round(JSON.stringify(prompt).length / 4);
    const estimatedOutputTokens = 2000; // Conservative estimate for JSON spec response
    const totalEstimatedTokens = promptLengthInTokens + estimatedOutputTokens;

    // GPT-4o pricing: $0.005 per 1K input tokens, $0.015 per 1K output tokens
    const inputCost = (promptLengthInTokens / 1000) * 0.005;
    const outputCost = (estimatedOutputTokens / 1000) * 0.015;
    const totalEstimatedCost = inputCost + outputCost;

    // LiteLLM timeout (60s)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    let completion;
    try {
      completion = await openai.chat.completions.create({
        model: process.env.LLM_MODEL || 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        response_format: { type: 'json_object' },
      });
    } finally {
      clearTimeout(timeout);
    }

    const content = completion.choices[0].message.content;
    if (!content) {
      throw new Error('No spec generated from LLM');
    }
    const spec = JSON.parse(content);
    if (spec.simulation && spec.simulation.initial_event && !spec.simulation.events[spec.simulation.initial_event]) {
      // Pick the first event as a fallback
      const firstEvent = Object.keys(spec.simulation.events)[0];
      spec.simulation.initial_event = firstEvent;
    }

    // 2. Generate data using the spec
    const factory = new DataFactory(spec);
    const generatedData = factory.generate(rowCount || 1000, timeRange || [new Date().getFullYear().toString()], schemaType);

    // Format the response
    const response = {
      ...generatedData,
      spec,
      cost: {
        estimated: totalEstimatedCost,
        inputTokens: promptLengthInTokens,
        outputTokens: estimatedOutputTokens,
        actualTokens: completion.usage?.total_tokens || totalEstimatedTokens,
        actualCost: completion.usage
          ? (completion.usage.prompt_tokens / 1000) * 0.005 + (completion.usage.completion_tokens / 1000) * 0.015
          : totalEstimatedCost,
      },
    };

    // Log cost for transparency
    const actualCost = completion.usage
      ? (completion.usage.prompt_tokens / 1000) * 0.005 + (completion.usage.completion_tokens / 1000) * 0.015
      : totalEstimatedCost;

    console.log(
      `[Dataset Generation] Business: ${businessType}, Rows: ${rowCount}, Cost: $${actualCost.toFixed(4)}, Tokens: ${
        completion.usage?.total_tokens || 'estimated'
      }`
    );

    return NextResponse.json({ data: response });
  } catch (error) {
    console.error('Error generating dataset:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
