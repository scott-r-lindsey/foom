# Config

Read [Config](../../../docs/areas/config.md), [Settings](../../../docs/areas/settings.md), plus the affected surface’s links in
[the file map](../../../docs/map.md), before changing this area.

- The config folder is plain files: Foom never creates, reads or writes a `.git` there, and leaves an existing one untouched.
- The config JSON scanner (`config/files.ts`) refuses links, nonregular files and JSON over 64 KiB, as does [offline JSON validation](../../../docs/areas/console.md). The separate [theme library](../../../docs/areas/themes.md#custom-theme-files-205) accepts a named file link only when its resolved target is directly in the same theme folder. A theme folder that is a link or resolves elsewhere is refused for reads, writes and removals.
- Concurrent writes use the config service’s validated, serialized writer.
- The folder never holds secrets; Foom sends nothing from it to any network service.
