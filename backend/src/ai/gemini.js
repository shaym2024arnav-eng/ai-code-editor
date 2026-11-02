// Thin wrapper around the Google Gen AI SDK with friendly error messages.
const { GoogleGenAI } = require("@google/genai");
const { HttpError } = require("../middleware/errors");

function toHttpError(err) {
  const status = err.status || err.code || (err.response && err.response.status);
  const msg = String(err.message || "");
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) {
    return new HttpError(429, "Gemini rate limit or quota reached. Wait a minute and try again.");
  }
  if (status === 400 && /API key/i.test(msg)) return new HttpError(502, "The Gemini API key is invalid.");
  if (status === 401 || status === 403) return new HttpError(502, "The Gemini API key was rejected. Check GEMINI_API_KEY.");
  if (status === 404) return new HttpError(502, "The configured Gemini model was not found. Check GEMINI_MODEL.");
  if (err.name === "AbortError" || /timed? ?out|deadline/i.test(msg)) {
    return new HttpError(504, "Gemini took too long to respond. Try a smaller file or selection.");
  }
  return new HttpError(502, "The AI service returned an error. Try again.");
}

const retryable = (err) => [500, 502, 503].includes(err.status || err.code);

function parseJson(text) {
  if (!text) throw new HttpError(502, "The AI returned an empty response.");
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new HttpError(502, "The AI returned malformed JSON. Try again.");
  }
}

function createGeminiClient({ apiKey, model }) {
  if (!apiKey) return null;
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 120000 } });

  async function call(request) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await ai.models.generateContent(request);
      } catch (err) {
        if (attempt === 0 && retryable(err)) continue;
        throw toHttpError(err);
      }
    }
    return null;
  }

  return {
    model,

    async generateJson({ system, prompt, schema, temperature = 0.2 }) {
      const res = await call({
        model,
        contents: prompt,
        config: {
          systemInstruction: system,
          responseMimeType: "application/json",
          responseJsonSchema: schema,
          temperature,
        },
      });
      return parseJson(res.text);
    },

    async generateText({ system, prompt, temperature = 0.3 }) {
      const res = await call({ model, contents: prompt, config: { systemInstruction: system, temperature } });
      const text = (res.text || "").trim();
      if (!text) throw new HttpError(502, "The AI returned an empty response.");
      return text;
    },
  };
}

module.exports = { createGeminiClient, parseJson, toHttpError };
