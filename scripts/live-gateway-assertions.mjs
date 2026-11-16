const imageMimeTypes = new Set(['png', 'jpeg', 'webp', 'gif']);

export function hasGeneratedImageDataUri(reply) {
  const content = reply?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return false;
  const prefix = '![Generated image](data:image/';
  if (!content.startsWith(prefix) || !content.endsWith(')')) return false;
  const separator = content.indexOf(';base64,', prefix.length);
  if (separator < 0 || !imageMimeTypes.has(content.slice(prefix.length, separator))) return false;
  const encoded = content.slice(separator + ';base64,'.length, -1);
  return encoded.length >= 16 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded);
}

export function hasResponsesOutputText(reply) {
  return (
    Array.isArray(reply?.output) &&
    reply.output.some(
      (item) =>
        item?.type === 'message' &&
        item.role === 'assistant' &&
        Array.isArray(item.content) &&
        item.content.some((part) => part?.type === 'output_text' && typeof part.text === 'string' && part.text.trim().length > 0),
    )
  );
}

const visionColorNames = new Set(['red', 'blue', 'green', 'yellow']);

function matchesExpectedVisionColor(value, expectedColor) {
  if (typeof value !== 'string' || !visionColorNames.has(expectedColor)) return false;
  const answer = /^(red|blue|green|yellow)[.!]?$/i.exec(value.trim());
  return answer?.[1].toLowerCase() === expectedColor;
}

export function hasChatVisionColor(reply, expectedColor) {
  return matchesExpectedVisionColor(reply?.choices?.[0]?.message?.content, expectedColor);
}

