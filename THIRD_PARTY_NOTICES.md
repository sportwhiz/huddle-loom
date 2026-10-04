# Third-party notices

Huddle Loom's original application code is MIT licensed. Dependencies and bundled fonts keep their own licenses. The MIT license at the repository root does not replace those terms.

## Editor and theme

- BlockSuite packages are pinned to 0.22.4. Their published package metadata declares MIT. The corresponding upstream repository also ships MPL-2.0; its notice is preserved in [licenses/upstream/blocksuite-0.22.4-LICENSE](licenses/upstream/blocksuite-0.22.4-LICENSE). Exact source is available at [tag v0.22.4](https://github.com/toeverything/blocksuite/tree/v0.22.4) and in the package source archives listed in the dependency inventory. Copyright notices for embedded drawing libraries are preserved separately.
- `@toeverything/theme` 1.1.23 ships MPL-2.0. Its license and unmodified corresponding source are included in [the complete upstream source archive](apps/web/public/licenses/upstream/toeverything-design-1.1.23.tar.gz). The archive is tag 1.1.23 at commit `2ce2dfa5d9c207e270d874275b3b3d2dd5cfaf91`; its theme source matches the published package. Copyright: TOEVERYTHING PTE. LTD. and its affiliates.
- The local StoreContainer, lazy-highlighter, and embed-branding adaptations identify their BlockSuite origin in their source headers. Changes to these adaptations are available in this repository.

The browser serves notices at `/licenses/index.html`. That page links the exact package sources and the theme source. Both Cloudflare and Node builds include it. Preserve these notices and source availability when redistributing a compiled application.

## Fonts and artwork

Caveat, Newsreader, and Source Sans 3 are distributed under the SIL Open Font License 1.1. Their full notices are included beside the font files in [brand/fonts](apps/web/public/brand/fonts). Theme font notices are included with the dependency notices.

Huddle Loom's brand illustrations were created for this project with image generation. They are included under the project's MIT license. They are not photographs of people or borrowed upstream product branding.

## Dependency inventory

[dependencies.json](apps/web/public/licenses/dependencies.json) records the installed package names, versions, declared licenses, source archive URLs, and preserved notice files. It includes build and test tools, so not every listed package is part of the distributed runtime.

Run `node scripts/licenses.mjs` after changing the lockfile. The script copies available package notices without rewriting them. Source archives remain under their upstream terms. Libraries without a packaged license file still appear with their declared license and exact source URL.

This inventory is a record of the supplied dependencies. It does not grant additional rights to upstream names or trademarks.
