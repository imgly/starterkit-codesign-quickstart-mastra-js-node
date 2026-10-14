// A brief in, a finished design out: Mastra runs the model through IMG.LY's gateway, the engine runs in one local executor.
import { mkdir, writeFile } from 'node:fs/promises';

import {
  googleFonts,
  prepareCoDesign,
  remoteExecutors
} from '@imgly/codesign-sdk';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';

const brief = process.argv[2];
const missing = [
  ...(brief ? [] : ['a brief (the first argument)']),
  ...['IMGLY_CESDK_LICENSE', 'EXECUTOR_TOKEN'].filter((n) => !process.env[n])
];
if (missing.length > 0) {
  console.error(
    `Missing ${missing.join(', ')}.\nUsage: npm start -- "<brief>", with the variables of .env.template set in .env` +
      (process.env.IMGLY_CESDK_LICENSE
        ? ''
        : '\nContact sales (https://img.ly/forms/contact-sales/) to get a CoDesign license key.')
  );
  process.exit(1);
}

const codesign = prepareCoDesign({
  // Your id for this job. Every design of a conversation opens on one executor
  // that serves no other conversation. Every run here is yours, so all share one.
  conversation: 'quickstart',
  executors: remoteExecutors({
    // The executor for a conversation. Here there is one; a product starts a
    // new one for each conversation.
    acquire: () => ({
      url: process.env.EXECUTOR_URL || 'http://localhost:8080'
    }),
    token: process.env.EXECUTOR_TOKEN
  }),
  // The CE.SDK plugins the engine applies: everything the agent can search and
  // place. Google Fonts is the smallest useful list; your own plugins go here.
  plugins: [googleFonts()],
  design: `quickstart-${Date.now()}`, // any id; with no `designs` store, the design lives in memory
  gateway: false // no image generation; the model still runs through the gateway
});

const textOf = (parts) =>
  parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n')
    .trim();

// The SDK's tools in Mastra's shape. Mastra takes their JSON Schema as it is; no zod.
const tools = Object.fromEntries(
  codesign.tools.map((t) => [
    t.name,
    createTool({
      id: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema,
      execute: async (args, { abortSignal }) => {
        const result = await t
          .call(args, { signal: abortSignal })
          .catch((err) => {
            console.log(`✗ ${t.name} (${err.kind ?? err.name})`); // rejected: the executor or your store failed
            throw err;
          });
        console.log(`${result.isError ? '✗' : '✓'} ${t.name}`);
        if (result.isError) throw new Error(textOf(result.content)); // the model reads it as a failed call
        return result.content;
      },
      // Renders go to the model as images, not as text.
      toModelOutput: (output) => ({
        type: 'content',
        value:
          /** @type {import('@imgly/codesign-sdk').ToolResult['content']} */ (
            output
          ).map((p) =>
            p.type === 'text'
              ? { type: 'text', text: p.text }
              : { type: 'media', mediaType: p.mimeType, data: p.data }
          )
      })
    })
  ])
);

// Chat Completions has no images in a tool result: move each render into a
// user message after it, so the model sees its work. Left out, nothing fails;
// the model designs blind. Mastra runs this before every model call.
/** @type {import('@mastra/core/processors').InputProcessor} */
const imagesAfterToolResults = {
  id: 'images-after-tool-results',
  processLLMRequest: ({ prompt }) => {
    const out = [];
    let images = [];
    const flush = () => {
      if (images.length === 0) return;
      out.push({
        role: 'user',
        content: [
          {
            type: /** @type {const} */ ('text'),
            text: 'Attached image(s) from tool result:'
          },
          ...images
        ]
      });
      images = [];
    };
    for (const message of prompt) {
      if (message.role !== 'tool') {
        flush();
        out.push(message);
        continue;
      }
      out.push({
        ...message,
        content: message.content.map((part) => {
          if (part.type !== 'tool-result' || part.output.type !== 'content')
            return part;
          const kept = [];
          for (const item of part.output.value) {
            if (item.type === 'media' && item.mediaType.startsWith('image/'))
              images.push({
                type: /** @type {const} */ ('file'),
                mediaType: item.mediaType,
                data: item.data
              });
            else kept.push(item);
          }
          if (kept.length === part.output.value.length) return part;
          return {
            ...part,
            output: {
              type: /** @type {const} */ ('content'),
              value:
                kept.length > 0
                  ? kept
                  : [
                      {
                        type: /** @type {const} */ ('text'),
                        text: '(see attached image)'
                      }
                    ]
            }
          };
        })
      });
    }
    flush();
    return { prompt: out };
  }
};

const agent = new Agent({
  id: 'designer',
  name: 'Designer',
  instructions: `You design marketing visuals. When you are done, say in one sentence what you made.\n\n${codesign.instructions}`,
  // IMG.LY's AI gateway speaks OpenAI's Chat Completions; your CoDesign license key is its API key.
  model: {
    providerId: 'imgly',
    modelId: process.env.MODEL || '@openrouter/anthropic/claude-opus-5',
    url: 'https://gateway.img.ly/v1',
    apiKey: process.env.IMGLY_CESDK_LICENSE
  },
  tools,
  inputProcessors: [imagesAfterToolResults]
});

/** A failure in one line: the SDK error's kind and the first line of its message, not a stack or a request body. */
const cause = (err) =>
  `${err?.kind ? `${err.kind}: ` : ''}${String(err instanceof Error ? err.message : err).split('\n')[0]}`;

// The free .imgly first: when the billed PNG export fails, or the run ends early, the design the model made is kept.
async function save(withPNG) {
  let file = 'out/design.imgly';
  try {
    await mkdir('out', { recursive: true });
    await writeFile(file, await codesign.export('imgly'));
    if (!withPNG) return console.error(`Wrote ${file}, the design so far.`);
    file = 'out/design.png';
    await writeFile(file, await codesign.export('png'));
    console.log('Wrote out/design.png and out/design.imgly');
  } catch (err) {
    console.error(`Could not write ${file}: ${cause(err)}`);
    process.exitCode = 1;
  }
}

const started = Date.now();
try {
  const run = await agent.generate(brief, { maxSteps: 60 });
  console.log(`\n${run.steps.at(-1)?.text ?? run.text}`); // run.text joins every step's text
  const { inputTokens, outputTokens } = run.totalUsage ?? {};
  console.log(
    `${run.steps.length} steps, ${Math.round((Date.now() - started) / 1000)} s, ` +
      `${inputTokens ?? '?'} input / ${outputTokens ?? '?'} output tokens`
  );
  if (run.finishReason !== 'stop') {
    console.error(`The model stopped early (${run.finishReason}).`);
    process.exitCode = 1;
  }
  await save(run.finishReason === 'stop');
} catch (err) {
  console.error(`The run failed: ${cause(err)}`);
  process.exitCode = 1;
  await save(false);
} finally {
  await codesign.release(); // ends the design's session now; the engine closes about 30 s later
}
