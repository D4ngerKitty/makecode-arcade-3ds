// Sound output for the 3DS: the synthesizer is pulled from by sound3ds.cpp.
#ifndef __SOUNDOUTPUT_H
#define __SOUNDOUTPUT_H

#define SAMPLE_RATE 32728 // the 3DS mixer's native rate

namespace music {
class WSynthesizer;

class N3dsDAC {
  public:
    WSynthesizer &src;
    N3dsDAC(WSynthesizer &data);
    int getSampleRate() { return SAMPLE_RATE; }
};

class SoundOutput {
  public:
    N3dsDAC dac;
    SoundOutput(WSynthesizer &data) : dac(data) {}
    void setOutput(int) {}
};

} // namespace music

#endif
