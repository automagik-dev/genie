"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.answerQuestion = answerQuestion;
exports.renderQaResult = renderQaResult;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// Basic tokenizer with accent folding for robust matching in PT/EN
function normalizeText(input) {
    return input
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}+/gu, '')
        .replace(/[^a-z0-9\s_\-/#.]/g, ' ');
}
function tokenize(input) {
    return normalizeText(input).split(/\s+/).filter(Boolean);
}
function isMarkdownFile(p) {
    return p.toLowerCase().endsWith('.md');
}
function walkDir(dir) {
    const out = [];
    const entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
        const full = path_1.default.join(dir, e.name);
        if (e.isDirectory()) {
            out.push(...walkDir(full));
        }
        else if (e.isFile() && isMarkdownFile(full)) {
            out.push(full);
        }
    }
    return out;
}
function resolveScopes(workspaceRoot, scopes) {
    // Default: all markdown under .genie
    if (!scopes || scopes.length === 0) {
        const base = path_1.default.join(workspaceRoot, '.genie');
        return fs_1.default.existsSync(base) ? walkDir(base) : [];
    }
    const files = [];
    for (const s of scopes) {
        const cleaned = s.trim();
        // Support @-prefixed paths: @.genie/skills/...
        const rel = cleaned.startsWith('@') ? cleaned.slice(1) : cleaned;
        const abs = path_1.default.resolve(workspaceRoot, rel);
        if (fs_1.default.existsSync(abs)) {
            const stat = fs_1.default.statSync(abs);
            if (stat.isDirectory()) {
                files.push(...walkDir(abs));
            }
            else if (stat.isFile() && isMarkdownFile(abs)) {
                files.push(abs);
            }
        }
    }
    return files;
}
function nearestHeading(lines, fromIndex) {
    for (let i = fromIndex; i >= 0; i--) {
        const line = lines[i];
        const m = /^(#{1,6})\s+(.*)$/.exec(line);
        if (m)
            return m[2].trim();
    }
    return undefined;
}
function scoreLine(line, queryTokens) {
    if (!line)
        return 0;
    const norm = normalizeText(line);
    let s = 0;
    for (const t of queryTokens) {
        if (!t)
            continue;
        // Count occurrences; cheap contains boost
        const re = new RegExp(`\\b${t.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'g');
        const matches = norm.match(re);
        if (matches)
            s += matches.length;
    }
    // Boost headings
    if (/^\s*#{1,6}\s+/.test(line))
        s *= 2;
    // Slightly boost bullets and definition lines
    if (/^\s*[-*]\s+/.test(line))
        s += 0.25;
    return s;
}
function makeSnippet(lines, center, window = 3) {
    const start = Math.max(0, center - window);
    const end = Math.min(lines.length - 1, center + window);
    const seg = lines.slice(start, end + 1).join('\n');
    return { start, end, text: seg };
}
function answerQuestion(question, options) {
    const { workspaceRoot } = options;
    const maxResults = options.maxResults ?? 5;
    const files = resolveScopes(workspaceRoot, options.scopes);
    const qTokens = tokenize(question);
    const snippets = [];
    for (const absFile of files) {
        let content;
        try {
            content = fs_1.default.readFileSync(absFile, 'utf8');
        }
        catch {
            continue;
        }
        const lines = content.split(/\r?\n/);
        const relFile = path_1.default.relative(workspaceRoot, absFile).split(path_1.default.sep).join('/');
        // Quick whole-file relevance
        const fileScore = scoreLine(content, qTokens);
        if (fileScore <= 0)
            continue;
        // Scan for strong lines
        const lineScores = lines.map((ln) => scoreLine(ln, qTokens));
        const candidates = lineScores
            .map((s, i) => ({ s, i }))
            .filter((r) => r.s > 0)
            .sort((a, b) => b.s - a.s)
            .slice(0, 5); // top spots per file
        for (const c of candidates) {
            const { start, end, text } = makeSnippet(lines, c.i, 3);
            const heading = nearestHeading(lines, c.i);
            const snippetScore = c.s + Math.log10(1 + fileScore);
            snippets.push({
                file: relFile,
                startLine: start + 1,
                endLine: end + 1,
                text,
                score: snippetScore,
                heading,
            });
        }
    }
    // Deduplicate overlapping snippets (same file and overlapping lines)
    const deduped = [];
    for (const s of snippets.sort((a, b) => b.score - a.score)) {
        const overlap = deduped.some((d) => d.file === s.file && !(s.endLine < d.startLine || s.startLine > d.endLine));
        if (!overlap)
            deduped.push(s);
        if (deduped.length >= maxResults)
            break;
    }
    return { question, snippets: deduped };
}
function renderQaResult(result) {
    const { question, snippets } = result;
    if (snippets.length === 0) {
        return `Q&A\nQuestion: ${question}\n\nNo relevant matches found in the selected scopes.`;
    }
    const lines = [];
    lines.push(`Q&A`);
    lines.push(`Question: ${question}`);
    lines.push('');
    // High-level bullets from headings
    lines.push('Top Findings:');
    for (const s of snippets) {
        const h = s.heading ? ` — ${s.heading}` : '';
        lines.push(`- ${s.file}:${s.startLine}${h}`);
    }
    lines.push('');
    lines.push('Excerpts:');
    for (const s of snippets) {
        lines.push(`- ${s.file}:${s.startLine}`);
        lines.push('  ' + s.text.split('\n').join('\n  '));
        lines.push('');
    }
    lines.push('References:');
    for (const s of snippets) {
        lines.push(`- ${s.file}:${s.startLine}`);
    }
    return lines.join('\n');
}
