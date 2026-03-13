#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const markdownIt = require("markdown-it");
const markdownItAnchor = require("markdown-it-anchor");
const Database = require("better-sqlite3");
const hljs = require("highlight.js");

// Paths
const WEB_ROOT = path.join(__dirname, "duckdb-web");
const DOCS_ROOT = path.join(WEB_ROOT, "docs", "stable");
const MENU_FILE = path.join(WEB_ROOT, "_data", "menu_docs_stable.json");
const DOCSET = path.join(__dirname, "DuckDB.docset");
const CONTENTS = path.join(DOCSET, "Contents");
const RESOURCES = path.join(CONTENTS, "Resources");
const DOCUMENTS = path.join(RESOURCES, "Documents");

// Collectors — populated during each render, then drained by the caller
let collectedHeadings = [];
let collectedFunctions = [];

function inlineText(token) {
  // After markdown-it-anchor wraps heading content, the inline token's .content
  // is empty but the text lives in .children (text and code_inline tokens).
  if (!token || !token.children) return token ? token.content : "";
  return token.children
    .filter((c) => c.type === "text" || c.type === "code_inline")
    .map((c) => c.content)
    .join("");
}

function headingCollectorPlugin(md) {
  md.core.ruler.push("collect_headings", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type !== "heading_open") continue;
      const level = parseInt(token.tag.slice(1), 10);
      if (level < 2 || level > 5) continue;
      const id = token.attrGet("id");
      const text = inlineText(tokens[i + 1]).trim();
      if (id && text) {
        collectedHeadings.push({ id, text });
      }
    }
  });
}

function functionCollectorPlugin(md) {
  // Identifies table columns named Function/Name/Alias from the thead,
  // then extracts function names from code spans in those columns.
  const NAME_HEADERS = new Set(["function", "name", "alias"]);

  md.core.ruler.push("collect_functions", (state) => {
    const tokens = state.tokens;
    let i = 0;
    while (i < tokens.length) {
      if (tokens[i].type !== "table_open") { i++; continue; }

      // Walk the thead to find which column indices are function/alias columns
      const fnCols = new Set();
      let colIdx = 0;
      i++;
      while (i < tokens.length && tokens[i].type !== "thead_close") {
        if (tokens[i].type === "th_open") {
          const inline = tokens[i + 1];
          const text = inline && inline.content ? inline.content.trim().toLowerCase() : "";
          if (NAME_HEADERS.has(text)) fnCols.add(colIdx);
          colIdx++;
        }
        i++;
      }

      if (fnCols.size === 0) {
        // Skip to table_close
        while (i < tokens.length && tokens[i].type !== "table_close") i++;
        continue;
      }

      // Walk tbody rows and extract code spans from the target columns
      while (i < tokens.length && tokens[i].type !== "table_close") {
        if (tokens[i].type === "tr_open") {
          let col = 0;
          i++;
          while (i < tokens.length && tokens[i].type !== "tr_close") {
            if (tokens[i].type === "td_open") {
              if (fnCols.has(col)) {
                const inline = tokens[i + 1];
                if (inline && inline.children) {
                  for (const child of inline.children) {
                    if (child.type !== "code_inline") continue;
                    // "func(args)" → extract func name; bare "alias_name" → take as-is
                    const mCall = child.content.match(/^([a-z_]\w*)\s*\(/);
                    if (mCall) {
                      collectedFunctions.push(mCall[1]);
                    } else {
                      const mBare = child.content.match(/^[a-z_]\w*$/);
                      if (mBare) collectedFunctions.push(mBare[0]);
                    }
                  }
                }
              }
              col++;
            }
            i++;
          }
        }
        i++;
      }
      i++;
    }
  });
}

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();

// markdown-it instance
const md = markdownIt({
  html: true,
  linkify: false,
  typographer: false,
  highlight(str, lang) {
    // Map DuckDB-specific language tags
    const alias = { plsql: "sql", batch: "bash", console: "text" };
    const resolved = alias[lang] || lang;
    if (resolved && hljs.getLanguage(resolved)) {
      return hljs.highlight(str, { language: resolved, ignoreIllegals: true }).value;
    }
    return ""; // use default escaping
  },
})
  .use(markdownItAnchor, {
    permalink: markdownItAnchor.permalink.headerLink({
      safariReaderFix: true,
      class: "header-anchor",
    }),
    slugify,
  })
  .use(headingCollectorPlugin)
  .use(functionCollectorPlugin);

// Dash table-of-contents anchors — renderer rule that prepends a dashAnchor
// before each h2–h5 so Dash can build an in-page TOC sidebar.
const defaultHeadingOpen =
  md.renderer.rules.heading_open ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.heading_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  const level = parseInt(token.tag.slice(1), 10);
  if (level >= 2 && level <= 5) {
    const text = inlineText(tokens[idx + 1]).trim();
    if (text) {
      const type = env.dashTocType || "Section";
      const encoded = encodeURIComponent(text);
      const anchor = `<a name="//apple_ref/cpp/${type}/${encoded}" class="dashAnchor"></a>\n`;
      return anchor + defaultHeadingOpen(tokens, idx, options, env, self);
    }
  }
  return defaultHeadingOpen(tokens, idx, options, env, self);
};

// ---------- 1. Parse menu structure ----------

function parseMenu() {
  const data = JSON.parse(fs.readFileSync(MENU_FILE, "utf8"));
  const pages = [];

  function walk(items, slugParts, section) {
    if (!items) return;
    for (const item of items) {
      const currentSlug = item.slug != null ? item.slug.replace(/\/$/, "") : null;
      const nextParts = currentSlug ? [...slugParts, currentSlug] : slugParts;
      const sectionName = section || item.page;

      if (item.url) {
        const dirPath = nextParts.join("/");
        const mdPath = dirPath
          ? path.join(DOCS_ROOT, dirPath, item.url + ".md")
          : path.join(DOCS_ROOT, item.url + ".md");
        const htmlPath = dirPath
          ? path.join(dirPath, item.url + ".html")
          : item.url + ".html";
        pages.push({
          name: item.page,
          mdPath,
          htmlPath,
          section: sectionName,
        });
      }

      // Recurse into sub-levels
      if (item.mainfolderitems) walk(item.mainfolderitems, nextParts, sectionName);
      if (item.subfolderitems) walk(item.subfolderitems, nextParts, sectionName);
      if (item.subsubfolderitems) walk(item.subsubfolderitems, nextParts, sectionName);
    }
  }

  walk(data.docsmenu, [], null);
  return pages;
}

// ---------- 2. Create docset skeleton ----------

function createSkeleton() {
  fs.rmSync(DOCSET, { recursive: true, force: true });
  fs.mkdirSync(DOCUMENTS, { recursive: true });

  // Info.plist
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>   <string>duckdb</string>
  <key>CFBundleName</key>         <string>DuckDB</string>
  <key>DocSetPlatformFamily</key> <string>duckdb</string>
  <key>isDashDocset</key>         <true/>
  <key>dashIndexFilePath</key>    <string>index.html</string>
  <key>DashDocSetFamily</key>     <string>dashtoc</string>
  <key>DashDocSetFallbackURL</key><string>https://duckdb.org/docs/stable/</string>
  <key>isJavaScriptEnabled</key>  <true/>
</dict>
</plist>`;
  fs.writeFileSync(path.join(CONTENTS, "Info.plist"), plist);

  // Icon
  const iconSrc = path.join(WEB_ROOT, "images", "favicon", "favicon-32x32.png");
  if (fs.existsSync(iconSrc)) {
    fs.copyFileSync(iconSrc, path.join(DOCSET, "icon.png"));
  }

  // Stylesheet
  fs.copyFileSync(path.join(__dirname, "style.css"), path.join(DOCUMENTS, "style.css"));

  // Railroad assets
  const rrJsSrc = path.join(WEB_ROOT, "js", "stable", "railroad.js");
  const rrCssSrc = path.join(WEB_ROOT, "css", "railroad.css");
  if (fs.existsSync(rrJsSrc)) fs.copyFileSync(rrJsSrc, path.join(DOCUMENTS, "railroad.js"));
  if (fs.existsSync(rrCssSrc)) fs.copyFileSync(rrCssSrc, path.join(DOCUMENTS, "railroad.css"));

  // Copy statement/expression/query_syntax JS files
  for (const subdir of ["statements", "expressions", "query_syntax"]) {
    const srcDir = path.join(WEB_ROOT, "js", "stable", subdir);
    if (!fs.existsSync(srcDir)) continue;
    const destDir = path.join(DOCUMENTS, subdir);
    fs.mkdirSync(destDir, { recursive: true });
    for (const f of fs.readdirSync(srcDir)) {
      if (f.endsWith(".js")) {
        fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f));
      }
    }
  }
}

// ---------- 3. Convert markdown → HTML ----------

function relativePrefix(htmlPath) {
  const depth = htmlPath.split("/").length - 1;
  return depth > 0 ? "../".repeat(depth) : "./";
}

function dashType(htmlPath) {
  if (htmlPath.startsWith("sql/statements/")) return "Statement";
  if (htmlPath.startsWith("sql/functions/")) return "Function";
  if (htmlPath.startsWith("sql/data_types/")) return "Type";
  if (htmlPath.startsWith("sql/query_syntax/")) return "Section";
  if (htmlPath.startsWith("sql/expressions/")) return "Expression";
  if (htmlPath.startsWith("clients/")) return "Guide";
  if (htmlPath.startsWith("extensions/") || htmlPath.startsWith("core_extensions/")) return "Guide";
  if (htmlPath.startsWith("configuration/")) return "Setting";
  return "Guide";
}

// Build a lookup from docs/stable relative .md path → html path in docset
function buildLinkMap(pages) {
  const map = new Map();
  for (const p of pages) {
    // Key: relative path from docs/stable, e.g. "sql/statements/select.md"
    const rel = path.relative(DOCS_ROOT, p.mdPath);
    map.set(rel, p.htmlPath);
    // Also map with docs/stable/ prefix for {% link %} tags
    map.set("docs/stable/" + rel, p.htmlPath);
  }
  return map;
}

function processBlockquotes(html) {
  // DuckDB uses blockquotes as callout boxes. The first word on the first line
  // determines the type: Note, Warning, Tip, Bestpractice, Deprecated.
  // We wrap them with a sidebar div similar to the site.
  const types = ["warning", "tip", "bestpractice", "deprecated", "note"];

  return html.replace(/<blockquote>\s*\n?([\s\S]*?)<\/blockquote>/g, (match, inner) => {
    // Check if the inner content starts with a known type keyword
    let boxType = "default";
    let content = inner;

    for (const t of types) {
      // Match at start: "> Warning" or "<p>Warning" etc
      const re = new RegExp(`^\\s*<p>\\s*${t}\\b`, "i");
      if (re.test(content)) {
        boxType = t.toLowerCase();
        // Remove the keyword from the content
        content = content.replace(
          new RegExp(`(<p>\\s*)${t}\\b[:\\s]?`, "i"),
          "$1"
        );
        break;
      }
    }

    return `<blockquote class="${boxType}"><div class="symbol"></div><div class="content">${content}</div></blockquote>`;
  });
}

function convertPage(page, linkMap) {
  if (!fs.existsSync(page.mdPath)) return null;

  let raw = fs.readFileSync(page.mdPath, "utf8");
  const { data: fm, content: mdContent } = matter(raw);

  const title = fm.title || page.name;
  const railroad = fm.railroad || null;

  // Replace {% link docs/stable/path/to/file.md %} with relative HTML paths
  let processed = mdContent.replace(
    /\{%\s*link\s+(.*?)\s*%\}/g,
    (match, linkPath) => {
      const htmlTarget = linkMap.get(linkPath);
      if (htmlTarget) {
        const from = path.dirname(page.htmlPath);
        return path.relative(from, htmlTarget) || htmlTarget;
      }
      // If not found, strip to just filename
      return linkPath.replace(/\.md$/, ".html");
    }
  );

  // Remove other Jekyll/Liquid tags that won't render
  processed = processed.replace(/\{%.*?%\}/g, "");

  // Render markdown (plugins populate collectedHeadings / collectedFunctions)
  collectedHeadings = [];
  collectedFunctions = [];
  const env = { dashTocType: dashType(page.htmlPath) };
  let html = md.render(processed, env);
  const headings = [...collectedHeadings];
  const functions = [...new Set(collectedFunctions)];

  // Post-process blockquotes into callout boxes
  html = processBlockquotes(html);

  const prefix = relativePrefix(page.htmlPath);

  // Build railroad script tags
  let railroadTags = "";
  if (railroad) {
    railroadTags += `\n    <link rel="stylesheet" href="${prefix}railroad.css">`;
    railroadTags += `\n    <script src="${prefix}railroad.js"></script>`;
    railroadTags += `\n    <script src="${prefix}${railroad}"></script>`;
  }

  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="${prefix}style.css">${railroadTags}
</head>
<body>
    <div class="container">
        <h1>${escapeHtml(title)}</h1>
        ${html}
    </div>${railroad ? '\n    <script>if (typeof Initialize === "function") Initialize();</script>' : ""}
</body>
</html>`;

  // Write file
  const destPath = path.join(DOCUMENTS, page.htmlPath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, fullHtml);

  return { title, headings, functions, railroad };
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------- 5. Build SQLite search index ----------

function buildIndex(pages, pageResults) {
  const dbPath = path.join(RESOURCES, "docSet.dsidx");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(
    `CREATE TABLE searchIndex(id INTEGER PRIMARY KEY, name TEXT, type TEXT, path TEXT);
     CREATE UNIQUE INDEX anchor ON searchIndex (name, type, path);`
  );

  const insert = db.prepare(
    "INSERT OR IGNORE INTO searchIndex(name, type, path) VALUES (?, ?, ?)"
  );

  const tx = db.transaction(() => {
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const result = pageResults[i];
      if (!result) continue;

      const type = dashType(page.htmlPath);
      insert.run(result.title, type, page.htmlPath);

      // Sub-entries from headings
      for (const h of result.headings) {
        insert.run(h.text, type, page.htmlPath + "#" + h.id);
      }

      // Function names extracted from tables
      for (const fn of result.functions) {
        insert.run(fn, "Function", page.htmlPath);
      }
    }
  });
  tx();

  // Stats
  const count = db.prepare("SELECT count(*) as n FROM searchIndex").get();
  db.close();
  return count.n;
}

// ---------- 6. Generate landing index.html ----------

function generateIndex(pages) {
  // Group pages by section
  const sections = new Map();
  for (const p of pages) {
    const sec = p.section || "Other";
    if (!sections.has(sec)) sections.set(sec, []);
    sections.get(sec).push(p);
  }

  let tocHtml = "";
  for (const [section, items] of sections) {
    tocHtml += `<h2>${escapeHtml(section)}</h2>\n<ul>\n`;
    for (const item of items) {
      tocHtml += `  <li><a href="${item.htmlPath}">${escapeHtml(item.name)}</a></li>\n`;
    }
    tocHtml += `</ul>\n`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>DuckDB Documentation</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <div class="container">
        <h1>DuckDB Documentation</h1>
        <p>Welcome to the DuckDB documentation. Use Dash search or browse sections below.</p>
        ${tocHtml}
    </div>
</body>
</html>`;

  fs.writeFileSync(path.join(DOCUMENTS, "index.html"), html);
}

// ---------- Main ----------

function main() {
  console.log("Parsing menu structure...");
  const pages = parseMenu();
  console.log(`Found ${pages.length} pages in menu`);

  console.log("Creating docset skeleton...");
  createSkeleton();

  console.log("Building link map...");
  const linkMap = buildLinkMap(pages);

  console.log("Converting markdown to HTML...");
  const pageResults = [];
  let converted = 0;
  let skipped = 0;
  for (const page of pages) {
    const result = convertPage(page, linkMap);
    pageResults.push(result);
    if (result) {
      converted++;
    } else {
      skipped++;
    }
  }
  console.log(`Converted ${converted} pages (${skipped} skipped — not found)`);

  console.log("Generating index page...");
  generateIndex(pages);

  console.log("Building search index...");
  const indexCount = buildIndex(pages, pageResults);
  console.log(`Search index: ${indexCount} entries`);

  console.log(`\nDone! Docset generated at ${DOCSET}`);
}

main();
