"""Inspect completed media without playing sound; write a local QA receipt."""
import argparse, array, hashlib, json, math, pathlib, re, subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--ffmpeg', required=True)
parser.add_argument('--ffprobe', required=True)
parser.add_argument('--video', required=True)
parser.add_argument('--audio', required=True)
parser.add_argument('--subtitles', required=True)
parser.add_argument('--duration', type=float, required=True)
parser.add_argument('--height', type=int, required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()

def run(exe, *params):
    return subprocess.run([exe, *params], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)

def inspect(filename):
    file = pathlib.Path(filename)
    metadata = json.loads(run(args.ffprobe, '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', str(file)).stdout)
    decoded = run(args.ffmpeg, '-v', 'error', '-i', str(file), '-f', 'null', '-')
    assert not decoded.stderr.strip(), decoded.stderr.decode(errors='replace')
    pcm = run(args.ffmpeg, '-v', 'error', '-i', str(file), '-map', '0:a:0', '-f', 'f32le', '-').stdout
    samples = array.array('f'); samples.frombytes(pcm)
    audio = next(stream for stream in metadata['streams'] if stream['codec_type'] == 'audio')
    size = int(audio['sample_rate']) * audio['channels']
    rms = lambda values: math.sqrt(sum(value * value for value in values) / len(values))
    return {'filename': file.name, 'bytes': file.stat().st_size, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(),
            'streams': metadata['streams'], 'duration': float(metadata['format']['duration']),
            'decodedAudioSeconds': len(samples) / size, 'firstSecondRms': rms(samples[:size]),
            'lastSecondRms': rms(samples[-size:]), 'fullDecode': True}

video, audio = inspect(args.video), inspect(args.audio)
picture = next(stream for stream in video['streams'] if stream['codec_type'] == 'video')
assert picture['height'] == args.height, picture
assert int(picture['nb_read_frames']) > args.duration * 10, picture
for result in [video, audio]:
    assert abs(result['duration'] - args.duration) < .5, result['duration']
    assert abs(result['decodedAudioSeconds'] - args.duration) < .5, result['decodedAudioSeconds']
    assert result['firstSecondRms'] > 0 and result['lastSecondRms'] > 0, result
assert next(stream for stream in audio['streams'] if stream['codec_type'] == 'audio')['codec_name'] == 'mp3'

subtitles = pathlib.Path(args.subtitles)
text = subtitles.read_text(encoding='utf-8-sig')
cues = []
for block in re.split(r'\n\s*\n', text.strip()):
    number, timing, *lines = block.splitlines()
    assert number == str(len(cues) + 1) and lines, block
    timestamps = re.findall(r'(\d{2}):(\d{2}):(\d{2}),(\d{3})', timing)
    assert len(timestamps) == 2, block
    seconds = [int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000 for h, m, s, ms in timestamps]
    assert 0 <= seconds[0] < seconds[1] <= args.duration + .1, seconds
    assert not cues or cues[-1]['start'] <= seconds[0], seconds
    cues.append({'start': seconds[0], 'end': seconds[1], 'text': '\n'.join(lines)})
assert cues, 'empty subtitles'
receipt = {'video': video, 'audio': audio, 'subtitles': {'filename': subtitles.name, 'bytes': subtitles.stat().st_size,
    'sha256': hashlib.sha256(subtitles.read_bytes()).hexdigest(), 'cues': cues}}
pathlib.Path(args.output).write_text(json.dumps(receipt, indent=2, ensure_ascii=False), encoding='utf-8')
print(json.dumps({'video': video['duration'], 'videoFrames': picture['nb_read_frames'], 'audio': audio['duration'],
    'subtitles': len(cues), 'fullDecode': True}))
