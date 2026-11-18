# Hosts redesign

This approved mockup is the design reference for #1259–#1264. Open
[index.html](index.html) in a browser and use the Scene and Theme selectors, or
pass a scene and theme in the URL, for example `?scene=ready&theme=dark`. The
mockup uses illustrative data. The area docs govern shipped behavior.

| Scene | Shows |
| --- | --- |
| list | Collapsed host cards with readiness and setup status |
| ready | Expanded ready host with checkout paths in Host facts |
| trust | Add host pauses at the SSH row for an unknown key |
| install | Installer terminal embedded in the host card |
| configure | Set up with an agent dialog |
| agent | Host card while a setup agent is running |
| fix | Git access failure with a Fix action |
| notes | Recorded requirements in Settings › Repositories |
