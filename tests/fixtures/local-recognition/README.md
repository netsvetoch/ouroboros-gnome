`goforward.raw` is the original human speech sample from PocketSphinx 5.1.1,
`test/data/goforward.raw` (mono signed little-endian PCM16 at 16000 Hz).
Utterance: “go forward ten meters”. The adjacent LICENSE is copied from that release.

Source: https://github.com/cmusphinx/pocketsphinx/tree/v5.1.1/test/data

Sample SHA256: f15c60ec54059d8b66e410d0064945a0b0a04ea56e1ddca1958e493c0cf70e71

Release archive SHA256: e2db414eb66618cd0a98de77507db32517a48f6900b06bfb94c0acc4bef5761d

Tests wrap the original PCM in a WAV header and invoke the actual decoder and
English model. No test recognizer returns a canned transcript. Scripted child
processes are used separately to exercise invalid output and nonzero exit status.
