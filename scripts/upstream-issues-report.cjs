#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readUpstreamRepos() {
  const filePath = path.join(process.cwd(), "config", "upstream-repos.json");

  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function githubJson(url, token) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "upstream-issues-report",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status} for ${url}: ${text}`);
  }

  return res.json();
}

async function fetchOpenIssues(upstreamRepo, token) {
  const issues = await githubJson(
    `https://api.github.com/repos/${upstreamRepo}/issues?state=open&per_page=100`,
    token
  );

  return issues
    .filter((item) => !item.pull_request)
    .map((item) => ({
      number: item.number,
      title: item.title || "",
      url: item.html_url,
    }));
}

function normalizeToLabUrl(upstreamRepo, value) {
  if (!value) return "";

  const repoName = upstreamRepo.split("/")[1];
  const trimmed = String(value).trim();

  const rawGithubMatch = trimmed.match(
    /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/([^/]+)\/refs\/heads\/main\/(.+)$/
  );
  if (rawGithubMatch) {
    const matchedRepo = rawGithubMatch[1];
    const filePath = rawGithubMatch[2].replace(/\.md$/i, ".html");
    return `https://microsoftlearning.github.io/${matchedRepo}/${filePath}`;
  }

  const pathMatch = trimmed.match(/(Instructions\/[A-Za-z0-9\-_/\.]+\.md)/i);
  if (pathMatch) {
    const filePath = pathMatch[1].replace(/\.md$/i, ".html");
    return `https://microsoftlearning.github.io/${repoName}/${filePath}`;
  }

  return "";
}

function escapePipes(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function parseExistingSelections(reportPath) {
  if (!fs.existsSync(reportPath)) {
    return new Map();
  }

  const content = fs.readFileSync(reportPath, "utf8");
  const lines = content.split(/\r?\n/);
  const selections = new Map();

  for (const line of lines) {
    if (!line.startsWith("| [")) continue;
    if (!line.includes("github.com/")) continue;

    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 4) continue;

    const issueCell = cells[0];
    const resolvable = cells[2] || "[ ]";
    const notResolvable = cells[3] || "[ ]";

    const urlMatch = issueCell.match(/\((https:\/\/github\.com\/[^)]+\/issues\/\d+)\)/);
    if (!urlMatch) continue;

    const issueUrl = urlMatch[1];
    selections.set(issueUrl, {
      resolvable: resolvable === "[x]" ? "[x]" : "[ ]",
      notResolvable: notResolvable === "[x]" ? "[x]" : "[ ]",
    });
  }

  return selections;
}

function buildMarkdownReport(results, generatedAt, priorSelections) {
  const reposWithIssues = results.filter((r) => r.issues.length > 0);
  const totalIssues = reposWithIssues.reduce((sum, r) => sum + r.issues.length, 0);

  const lines = [];

  lines.push("# Upstream open issues report");
  lines.push("");
  lines.push(`Updated (UTC): ${generatedAt}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Upstream repo | Open issues |");
  lines.push("|---|---:|");

  for (const repoResult of reposWithIssues) {
    lines.push(`| ${repoResult.upstreamRepo} | ${repoResult.issues.length} |`);
  }

  lines.push("");
  lines.push(`**Repos with open issues:** ${reposWithIssues.length}  `);
  lines.push(`**Total open issues:** ${totalIssues}`);
  lines.push("");
  lines.push("## Review table");
  lines.push("");
  lines.push("| Issue | Candidate lab URL(s) | Resolvable | Not resolvable |");
  lines.push("|---|---|---|---|");

  for (const repoResult of reposWithIssues) {
    for (const issue of repoResult.issues) {
      const candidateLabUrl = normalizeToLabUrl(repoResult.upstreamRepo, issue.title);
      const prior = priorSelections.get(issue.url) || {
        resolvable: "[ ]",
        notResolvable: "[ ]",
      };

      const issueCell = `[${repoResult.upstreamRepo} #${issue.number}](${issue.url}) — ${escapePipes(issue.title)}`;
      lines.push(
        `| ${issueCell} | ${escapePipes(candidateLabUrl)} | ${prior.resolvable} | ${prior.notResolvable} |`
      );
    }
  }

  lines.push("");

  return lines.join("\n");
}

function writeReport(markdown) {
  const outDir = path.join(process.cwd(), "gh-reports");
  const outPath = path.join(outDir, "upstream-issues-report.md");

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, markdown, "utf8");

  return outPath;
}

async function main() {
  const token = requireEnv("GITHUB_TOKEN");
  const upstreamRepos = readUpstreamRepos();
  const reportPath = path.join(process.cwd(), "gh-reports", "upstream-issues-report.md");
  const priorSelections = parseExistingSelections(reportPath);

  const results = [];

  for (const upstreamRepo of upstreamRepos) {
    const issues = await fetchOpenIssues(upstreamRepo, token);
    results.push({ upstreamRepo, issues });
  }

  const markdown = buildMarkdownReport(results, new Date().toISOString(), priorSelections);
  const outPath = writeReport(markdown);

  const reposWithIssues = results.filter((r) => r.issues.length > 0).length;
  const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0);

  console.log(`Repos with open issues: ${reposWithIssues}`);
  console.log(`Total open issues: ${totalIssues}`);
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
