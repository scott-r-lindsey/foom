# Config

Read [Config](../../../docs/areas/config.md), [Settings](../../../docs/areas/settings.md), plus the affected surface’s links in
[the file map](../../../docs/map.md), before changing this area.

- The config folder is plain files: Foom never creates, reads or writes a `.git` there, and leaves an existing one untouched.
- Reads refuse links, nonregular files and files over 64 KiB; a theme folder that is a link or resolves elsewhere is refused for reads, writes and removals.
- Concurrent writes use the config service’s validated, serialized writer.
- The folder never holds secrets; Foom sends nothing from it to any network service.
