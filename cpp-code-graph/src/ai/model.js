'use strict';

// Access to a language model through VS Code's Language Model API.

const vscode = require('vscode');

const JUSTIFICATION = 'Answer questions about the C/C++ code graph.';

/**
 * Copilot's "Auto" entry routes each request by its chat prompt, which requests
 * from an extension don't have, so it rejects them ("Auto mode needs a prompt or
 * a command to route a request").
 */
function isRouter(m) {
  return [m.id, m.name, m.family].some(s => /\bauto\b/i.test(String(s || '')));
}

/** The best available chat model (Claude, then GPT-4/5 class, then anything), or null. Router models come last. */
async function selectModel() {
  let models = [];
  try {
    models = await vscode.lm.selectChatModels();
  } catch {
    models = [];
  }
  if (!models.length) return null;
  const real = models.filter(m => !isRouter(m));
  const pool = real.length ? real : models;
  return pool.find(m => /claude/i.test(m.family || m.id)) || pool.find(m => /gpt-4|gpt-5|o\d/i.test(m.family || '')) || pool[0];
}

/** Runs a model request; any error it throws is marked as coming from the model. */
async function fromModel(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && typeof err === 'object') err.fromModel = true;
    throw err;
  }
}

/** Sends one user prompt and calls onText with the accumulated text as it streams. Returns the full text. */
async function streamText(model, prompt, token, onText) {
  const messages = [vscode.LanguageModelChatMessage.User(prompt)];
  let text = '';
  await fromModel(async () => {
    const response = await model.sendRequest(messages, { justification: JUSTIFICATION }, token);
    for await (const chunk of response.text) {
      text += chunk;
      onText(text);
    }
  });
  return text;
}

/** True for errors raised by the model request itself (as opposed to bugs in our code). */
function isModelError(err) {
  return err instanceof vscode.LanguageModelError || !!(err && (err.code || err.fromModel));
}

/** Whether this VS Code (1.95+) and model can do tool calling. */
function supportsTools(model) {
  if (typeof vscode.LanguageModelToolCallPart !== 'function' || typeof vscode.LanguageModelToolResultPart !== 'function') return false;
  if (typeof vscode.LanguageModelChatMessage.Assistant !== 'function') return false;
  const caps = model && model.capabilities;
  return !(caps && (caps.supportsToolCalling === false || caps.toolCalling === false));
}

/**
 * Wraps a chat model in the adapter the agent expects (see agent.js):
 * send(messages, {tools, forceTool}, token) -> {text, calls}.
 */
function toolAdapter(model) {
  const { LanguageModelChatMessage: Msg, LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result } = vscode;
  const toVscode = m => {
    if (m.role === 'assistant') {
      const parts = [];
      if (m.text) parts.push(new Text(m.text));
      for (const c of m.calls || []) parts.push(new Call(c.id, c.name, c.input || {}));
      return Msg.Assistant(parts);
    }
    if (m.results) {
      const parts = m.results.map(r => new Result(r.id, [new Text(r.text)]));
      if (m.text) parts.push(new Text(m.text));
      return Msg.User(parts);
    }
    return Msg.User(m.text);
  };
  return {
    name: model.name || model.family,
    maxInputTokens: model.maxInputTokens,
    async send(messages, opts, token) {
      const options = {
        justification: JUSTIFICATION,
        tools: (opts.tools || []).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
      };
      if (opts.forceTool && vscode.LanguageModelChatToolMode) options.toolMode = vscode.LanguageModelChatToolMode.Required;
      const vmsgs = messages.map(toVscode);
      let text = '';
      const calls = [];
      await fromModel(async () => {
        const response = await model.sendRequest(vmsgs, options, token);
        // Parts are recognized by shape, so this also works with test doubles.
        for await (const part of response.stream) {
          if (part && typeof part.callId === 'string') calls.push({ id: part.callId, name: part.name, input: part.input || {} });
          else if (part && typeof part.value === 'string') text += part.value;
        }
      });
      return { text, calls };
    }
  };
}

module.exports = { selectModel, streamText, isModelError, supportsTools, toolAdapter };
