---
title: CLI
---

# CLI

The 0.12 CLI configures and checks a repository. Runtime automation belongs to MCP; people can also
use the web UI.

```text
facility init      write .facility.yml and .agents/*.md
facility doctor    validate the local workspace contract
facility instance bootstrap
                   bind the first owner and GitHub installation
```

Use `facility init --help` for environment and model flags. Init preserves existing files unless
`--force` is explicit.
