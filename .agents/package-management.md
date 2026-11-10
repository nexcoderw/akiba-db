# Package Management and Releases

## Purpose and scope

Publish a stable private package that `akiba-api` can consume without source coupling.

## Mandatory engineering requirements

Use npm, GitHub Packages, scope `@nexcoderw`, explicit exports, compiled ESM/declarations, and SemVer.
Generate Prisma Client before build so it is compiled into `dist`; package consumers never generate it
and never copy the schema. Pin an explicit package version in the API lockfile. Published versions and
tags are immutable. Runtime dependencies ship as dependencies; Nest remains a peer dependency.

## Forbidden patterns

No tokens in repository files, `latest` dependencies in consumers, mutable re-publication, deep
imports, or consumer postinstall generation from this repository.

## Correct example

After human verification, publish `0.2.0`; `akiba-api` installs exactly `@nexcoderw/akiba-db@0.2.0`.

## Common mistakes

Publishing before generation/build, omitting declarations, or putting `@prisma/adapter-pg` only in
development dependencies.

## Review checklist

- Packed contents contain `dist/index.js`, declarations, and generated client output.
- version, tag, changelog, schema compatibility, and registry authentication are correct.
