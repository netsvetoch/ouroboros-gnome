/* Bounded PCM16LE/16kHz speech gate for the local recognizer.
 * Uses PocketSphinx's bundled WebRTC VAD; does not load a speech model.
 * No audio files, network calls, transcripts, or logging. */
#include <stddef.h>
#include <pocketsphinx/vad.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(void)
{
    enum { FRAME = 480, MAX_SAMPLES = 16000 * 60 };
    unsigned char bytes[FRAME * 2];
    int16 frame[FRAME];
    size_t total = 0, voiced = 0, run = 0, longest = 0;
    int status = 1;
    ps_vad_t *vad = ps_vad_init(PS_VAD_MEDIUM_STRICT, 16000, 0.03);
    if (!vad || ps_vad_frame_size(vad) != FRAME)
        goto done;
    for (;;) {
        size_t length = fread(bytes, 1, sizeof(bytes), stdin);
        if (ferror(stdin) || length % 2 || total + length / 2 > MAX_SAMPLES)
            goto done;
        if (!length)
            break;
        total += length / 2;
        memset(frame, 0, sizeof(frame));
        for (size_t i = 0; i < length / 2; ++i) {
            unsigned value = (unsigned)bytes[2 * i] | ((unsigned)bytes[2 * i + 1] << 8);
            frame[i] = value < 32768 ? (int16)value : (int16)((int)value - 65536);
        }
        ps_vad_class_t speech = ps_vad_classify(vad, frame);
        if (speech == PS_VAD_ERROR)
            goto done;
        if (speech == PS_VAD_SPEECH) {
            voiced += length / 2;
            run += length / 2;
            if (run > longest)
                longest = run;
        } else {
            run = 0;
        }
    }
    if (!total)
        goto done;
    /* Reject isolated start-up transients; retain the original full clip for
     * decoding when at least 180ms of contiguous speech has been detected. */
    if (printf("{\"samples\":%zu,\"voiced_samples\":%zu,\"longest_samples\":%zu,\"speech\":%s}\n",
               total, voiced, longest, longest >= 2880 ? "true" : "false") < 0 || fflush(stdout))
        goto done;
    status = 0;
done:
    if (vad)
        ps_vad_free(vad);
    return status;
}
