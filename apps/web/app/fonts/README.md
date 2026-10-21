# IBM Plex web fonts

These unmodified, complete WOFF2 fonts come from the official [IBM Plex repository](https://github.com/IBM/plex/tree/71f558992315a12ca1f06a2215d57962a1992162/packages), pinned to commit `71f558992315a12ca1f06a2215d57962a1992162`. [sources.json](sources.json) records each upstream path, Git blob, SHA-256 digest and byte size. The download was checked against the upstream Git blobs and WOFF2 signatures.

The web application uses the same normal styles and weights as its previous Google Fonts configuration: Sans 400/500/600/700 and Mono 400/500/600. The complete upstream files retain their character coverage. `next/font/local` emits cacheable font assets during the build; font loading no longer requires Google Fonts responses.

Copyright 2017 IBM Corp., with Reserved Font Name "Plex". Distributed under the [SIL Open Font License 1.1](OFL.txt), copied from the same upstream commit. The files have not been subsetted, renamed internally or modified.
