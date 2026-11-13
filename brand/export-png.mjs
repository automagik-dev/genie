#!/usr/bin/env node
// Makes a PNG from one of the brand SVGs, on a clear ground.
//
//   node docs/brand/export-png.mjs <file.svg> <height in px> [out.png]
//
// The SVGs use masks and blur, so a browser draws them: this needs playwright-core (in the root
// package.json) and a Chromium. Set BRAND_CHROME to a Chromium's path, or install playwright's
// own with `bunx playwright-core install chromium`.
// Without [out.png] the file is written beside the SVG as <name>-<height>.png.
// Pick the drawing made for the size; README.md has the table.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [file, size, out] = process.argv.slice(2)
const height = Number(size)
if (!file || !file.endsWith('.svg') || !Number.isInteger(height) || height < 1) {
  console.error('usage: node docs/brand/export-png.mjs <file.svg> <height in px> [out.png]')
  process.exit(2)
}
const svg = readFileSync(file, 'utf8')
const box = /viewBox="([^"]+)"/.exec(svg)?.[1].trim().split(/[\s,]+/).map(Number)
if (!box || box.length !== 4 || !(box[2] > 0) || !(box[3] > 0)) {
  console.error(`${file}: no viewBox`)
  process.exit(1)
}
const width = Math.round((height * box[2]) / box[3])
const target = resolve(out ?? file.replace(/\.svg$/, `-${height}.png`))
const { chromium } = await import('playwright-core')
const browser = await chromium.launch({ executablePath: process.env.BRAND_CHROME || undefined, headless: true })
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block}</style><img src="${source}" width="${width}" height="${height}">`)
  await page.evaluate(() => document.images[0].decode())
  writeFileSync(target, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width, height } }))
  console.log(`${target} ${width}x${height}`)
} finally {
  await browser.close()
}
