---
id: sta-e047
status: closed
deps: [sta-ent0, sta-4fzz]
links: []
created: 2026-03-26T14:25:09Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Add Zola templates for the plugins section

On the pages branch, create templates/plugins/list.html and templates/plugins/page.html mirroring the existing skills templates. The list page shows a card per plugin (title, description). The detail page shows the plugin name, description, and an install modal. The install modal text should be: 'Please install the plugin <repo_url>' where repo_url comes from page.extra.repo_url. No version/author metadata (plugins don't have these). Style should match the skills section exactly.

