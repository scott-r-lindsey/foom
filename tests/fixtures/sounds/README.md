These three 0.1-second, 440 Hz sine tones were generated with FFmpeg for offline
metadata-parser tests. They contain no third-party recording. Reproduce with:

```sh
ffmpeg -f lavfi -i 'sine=frequency=440:duration=0.1' -c:a libmp3lame tone.mp3
ffmpeg -f lavfi -i 'sine=frequency=440:duration=0.1' -c:a flac tone.flac
ffmpeg -f lavfi -i 'sine=frequency=440:duration=0.1' -c:a libvorbis tone.ogg
```

Bundled application recordings supply separate Ogg/Opus coverage; WAV fixtures
are constructed in tests so malformed lengths can be tested without allocating
large buffers.
