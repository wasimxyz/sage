# Sage documentation

These pages explain how Sage works once you are past the [README](../README.md). Start with Architecture, then read the pages for the area you are changing.

## The app

- [Architecture](architecture.md): the Zig core, the web view, the bridge, SQLite, threads, Ollama, and the eve agent
- [The journal](journal.md): writing, saving, importing, exporting, and searching entries, and the Home screen
- [Dream](dream.md): the job that summarizes entries, titles chats, and extracts memories
- [Models](models.md): Settings > Models, recommended models, and starting Ollama
- [First-launch setup](onboarding.md): the setup screens, the rows they save, and the reminders to protect your journal

## Chat and memory

- [Chat at a glance](agent/README.md): the three processes and how a question gets an answer
- [The eve app](agent/eve-app.md): the agent’s files, model selection, tools, and configuration
- [The Chat frontend](agent/frontend.md): how the React screen streams, saves, and reopens conversations
- [Chat storage](agent/storage.md): the chat tables, the save protocol, export, and deleting data
- [Memories](agent/memories.md): the optional memory build, Facts and Events, and how your edits stay after Dream

## Evals

- [Eval suite](agent/evals.md): grading Dream and Chat against a local dataset
- [Eval reports](agent/evals-reports.md): reading results and fixing runner failures
- [Eval suite internals](../agent/evals/README.md): the runner steps, the eval files, and the shared helpers
- [Eval fixtures](../agent/evals/data/README.md): how to write a case
- [Eval viewer](../eval-viewer/README.md): the Next.js app that lists uploaded reports

## Security

- [Security at a glance](security/README.md): what Sage protects, what stays readable, and where the code lives
- [The app lock](security/lock.md): the password, Touch ID, wrong guesses, and automatic locking
- [Encryption at rest](security/encryption.md): the data key, the key slots, the field format, and Chat workflow files
- [The Touch ID Keychain mirror](security/keychain.md): the Keychain copy of the data key
- [Recovery](security/recovery.md): the recovery key and what to do when something breaks
- [Local agent server](security/agent-server.md): how Chat tools read the journal and how the Chat port checks the token
- [Testing the lock and encryption](security/testing.md): the unit suite, the security tests, and the automation server

## Building and scripts

- [Scripts](../scripts/README.md): packaging the app and running evals
- [Releasing Sage](release.md): the update key, cutting a release, and how installed copies update
- [AGENTS.md](../AGENTS.md): rules for coding agents in this repo
