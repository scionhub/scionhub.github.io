---
title: Home
nav_order: 1
---

# OpenScion

OpenScion is an open-source, server-centric source control system for very large monorepos where most clients are AI agents and CI jobs rather than people on laptops. It follows the design Anthropic described for its internal system, Scion, in [*Redesigning source control*](https://www.anthropic.com/engineering/redesigning-source-control).

Instead of every client holding full history, **the server does the work**: history, blame, commits, rebases and merges run server-side, while clients keep a bounded cache. Changesets list only changed files, every object is content-addressed with BLAKE3, refs move by compare-and-swap with no global merge lock, source control operations are RPCs, and clients fetch only the trees and blobs they name.

Source code: [github.com/scionhub/openscion](https://github.com/scionhub/openscion)

- [Documentation overview](README.md)

## Research

- [Research](research/README.md)
- [Background: git internals](research/git-internals.md)
- [Background: git transfer and scaling](research/git-transfer-and-scaling.md)
- [Background: GitHub](research/github.md)
- [Background: GitLab](research/gitlab.md)
- [Background: Scion](research/scion.md)

## Specs

- [Specifications](specs/README.md)
- [Example: Retry policy](specs/example-retry-policy.md)
- [OpenScion API](specs/openscion-api.md)
- [OpenScion architecture](specs/openscion-architecture.md)
- [OpenScion data model](specs/openscion-data-model.md)

## Plans

- [Implementation plans](plans/README.md)
- [Example plan: Retry policy](plans/example-retry-policy.md)
- [Plan: OpenScion core data model](plans/openscion-data-model.md)

## Architecture decision records

- [1. Record architecture decisions](adr/0001-record-architecture-decisions.md)
