/**
 * Replace one top-level JSON string property without touching formatting or a
 * same-named nested property. JSON.parse validates the document; the scanner
 * only locates the already-validated top-level token.
 *
 * @param {string} source
 * @param {string} property
 * @param {string} value
 * @returns {string}
 */
export function replaceTopLevelStringProperty(source, property, value) {
  const parsed = JSON.parse(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('metadata must be a top-level JSON object');
  }
  if (typeof parsed[property] !== 'string') {
    throw new Error(`top-level ${property} must be a string`);
  }

  /** @type {Array<'{'|'['>} */
  const stack = [];
  /** @type {Array<{start: number, end: number}>} */
  const matches = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }
    if (char === '}' || char === ']') {
      stack.pop();
      continue;
    }
    if (char !== '"') continue;

    const tokenStart = index;
    index += 1;
    for (; index < source.length; index += 1) {
      if (source[index] === '\\') {
        index += 1;
        continue;
      }
      if (source[index] === '"') break;
    }
    if (index >= source.length) throw new Error('unterminated JSON string');
    const tokenEnd = index + 1;
    if (stack.length !== 1 || stack[0] !== '{') continue;
    if (JSON.parse(source.slice(tokenStart, tokenEnd)) !== property) continue;

    let colon = tokenEnd;
    while (/\s/.test(source[colon] ?? '')) colon += 1;
    if (source[colon] !== ':') continue;
    let valueStart = colon + 1;
    while (/\s/.test(source[valueStart] ?? '')) valueStart += 1;
    if (source[valueStart] !== '"') throw new Error(`top-level ${property} must be a JSON string token`);
    let valueEnd = valueStart + 1;
    for (; valueEnd < source.length; valueEnd += 1) {
      if (source[valueEnd] === '\\') {
        valueEnd += 1;
        continue;
      }
      if (source[valueEnd] === '"') break;
    }
    if (valueEnd >= source.length) throw new Error(`unterminated top-level ${property} value`);
    matches.push({ start: valueStart, end: valueEnd + 1 });
  }

  if (matches.length !== 1) {
    throw new Error(`metadata must contain exactly one top-level ${property} property`);
  }
  const match = matches[0];
  const updated = `${source.slice(0, match.start)}${JSON.stringify(value)}${source.slice(match.end)}`;
  const reparsed = JSON.parse(updated);
  if (reparsed[property] !== value) throw new Error(`could not update top-level ${property}`);
  return updated;
}
