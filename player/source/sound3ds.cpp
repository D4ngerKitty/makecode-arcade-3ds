// Sound output for the 3DS.
//
// MakeCode's synthesizer (pxt/mixer/melody.cpp) produces samples on demand.
// A small high-priority thread keeps a few short buffers queued on the 3DS
// sound chip, refilling each one as it finishes playing.

#include <3ds.h>

#include "pxt.h"
#include "SoundOutput.h"
#include "melody.h"

#include <string.h>

#define BUF_SAMPLES 512 // about 16 ms each
#define NUM_BUFS 4

namespace pxt {

// The synthesizer is touched by the game (starting sounds) and by the sound
// thread (producing samples); this lock keeps them apart. The runtime calls
// it "disabling interrupts" because that is what it is on a microcontroller.
static RecursiveLock soundLock;
static bool soundLockReady;

void target_disable_irq() {
    if (soundLockReady)
        RecursiveLock_Lock(&soundLock);
}

void target_enable_irq() {
    if (soundLockReady)
        RecursiveLock_Unlock(&soundLock);
}

} // namespace pxt

namespace music {

static ndspWaveBuf waveBufs[NUM_BUFS];
static int16_t *sampleMem;
static LightEvent frameEvent;
static WSynthesizer *synth;
static volatile bool soundRunning;

static void frameCallback(void *) {
    LightEvent_Signal(&frameEvent);
}

static void soundThread(void *) {
    while (soundRunning) {
        for (int i = 0; i < NUM_BUFS; ++i) {
            auto wb = &waveBufs[i];
            if (wb->status != NDSP_WBUF_DONE && wb->status != NDSP_WBUF_FREE)
                continue;
            auto dst = (int16_t *)wb->data_pcm16;
            pxt::target_disable_irq();
            synth->fillSamples(dst, BUF_SAMPLES);
            pxt::target_enable_irq();
            // The synthesizer makes 12-bit samples; scale up to 16-bit, at
            // half volume to leave headroom when several sounds overlap.
            for (int j = 0; j < BUF_SAMPLES; ++j)
                dst[j] = dst[j] << 3;
            DSP_FlushDataCache(dst, BUF_SAMPLES * 2);
            wb->nsamples = BUF_SAMPLES;
            ndspChnWaveBufAdd(0, wb);
        }
        LightEvent_Wait(&frameEvent);
    }
}

static bool soundStarted;

// Silences the sound while the in-game menu is open.
void setSoundPaused(bool paused) {
    if (soundStarted)
        ndspSetMasterVol(paused ? 0.0f : 1.0f);
}

void shutdownSound() {
    if (!soundStarted)
        return;
    soundRunning = false;
    LightEvent_Signal(&frameEvent);
    ndspChnWaveBufClear(0);
    ndspExit();
}

N3dsDAC::N3dsDAC(WSynthesizer &data) : src(data) {
    synth = &data;

    // Sound needs the DSP firmware dumped on the SD card (sdmc:/3ds/dspfirm.cdc).
    // Without it the game simply runs silent.
    if (R_FAILED(ndspInit())) {
        DMESG("No sound: DSP firmware (dspfirm.cdc) not found");
        return;
    }

    RecursiveLock_Init(&pxt::soundLock);
    pxt::soundLockReady = true;

    ndspSetOutputMode(NDSP_OUTPUT_STEREO);
    ndspChnReset(0);
    ndspChnSetInterp(0, NDSP_INTERP_LINEAR);
    ndspChnSetRate(0, SAMPLE_RATE);
    ndspChnSetFormat(0, NDSP_FORMAT_MONO_PCM16);
    float mix[12];
    memset(mix, 0, sizeof(mix));
    mix[0] = mix[1] = 1.0f;
    ndspChnSetMix(0, mix);

    sampleMem = (int16_t *)linearAlloc(NUM_BUFS * BUF_SAMPLES * 2);
    memset(sampleMem, 0, NUM_BUFS * BUF_SAMPLES * 2);
    memset(waveBufs, 0, sizeof(waveBufs));
    for (int i = 0; i < NUM_BUFS; ++i) {
        waveBufs[i].data_vaddr = sampleMem + i * BUF_SAMPLES;
        waveBufs[i].status = NDSP_WBUF_FREE;
    }

    LightEvent_Init(&frameEvent, RESET_ONESHOT);
    ndspSetCallback(frameCallback, NULL);

    // Higher priority (lower number) than the game, so sound never waits on it.
    s32 prio = 0x30;
    svcGetThreadPriority(&prio, CUR_THREAD_HANDLE);
    soundRunning = true;
    soundStarted = true;
    threadCreate(soundThread, NULL, 32 * 1024, prio - 1, -1, true);
}

} // namespace music
