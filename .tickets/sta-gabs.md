---
id: sta-gabs
status: open
deps: [sta-ent0, sta-4fzz]
links: []
created: 2026-03-26T14:25:06Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Extend build-pages.sh to generate plugin pages from GitHub API

On the pages branch, extend build-pages.sh to fetch all plugin-* repos from the stavrobot GitHub org via the GitHub API (unauthenticated is fine). For each repo, fetch manifest.json from the repo's default branch to get the plugin name. Generate Zola content files under content/plugins/ with TOML front matter (title = proper-cased manifest name, description = GitHub repo description, template = plugins/page.html, extra.repo_url = GitHub URL). Also generate content/plugins/_index.md with sort_by=title and template=plugins/list.html. Skip repos where manifest.json fetch fails.

