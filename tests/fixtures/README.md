# Synthetic parser controls

`parser-control.flac` and `parser-control-av1.mp4` were generated locally with FFmpeg 9.0.2 using the commands below. They contain a generated 440 Hz tone and a 16 x 16 blue image respectively; no user or platform media is included. FFmpeg is only needed to regenerate them, not to run the tests.

```sh
ffmpeg -hide_banner -loglevel error -n -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.12" -c:a flac -sample_fmt s16 -compression_level 0 -frame_size 192 -metadata_header_padding 0 parser-control.flac
ffmpeg -hide_banner -loglevel error -n -f lavfi -i "color=c=blue:size=16x16:rate=5:duration=0.4" -an -c:v libaom-av1 -cpu-used 8 -crf 40 -g 16 parser-control-av1.mp4
```

Independent `ffprobe` inspection established five FLAC packets of 192 samples at 8 kHz (0.12 s), starting at byte offsets 90/325/560/795/1030, with lengths 235/235/235/235/236. The AV1 MP4 contains two 16 x 16 packets, key then delta, at 0/0.2 s, with lengths 33/19 and a total duration of 0.4 s. Both complete files decoded to a null sink without errors. The tests exercise the shipped parser and never play audio.

`raw-recording.webm` is an earlier separate recording control; other fixtures model their named adapters.
