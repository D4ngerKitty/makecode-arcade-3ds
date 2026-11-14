// Native helpers for the speed-tuned MakeCode libraries (tools/patch-libs.js).
//
// MakeCode's compiler only lets game code call runtime functions it already
// knows about, so new helpers cannot simply be added under new names. Instead
// they are reached through three existing functions that do nothing useful
// on this platform:
//
//   multiplayer::postIcon(op, arg, image)     -> runs helper number `op`
//   Keyboard::getTextPromptSelectionStart()   -> first result of the last helper
//   Keyboard::getTextPromptSelectionEnd()     -> second result
//
// Helper numbers start at 0x3d50001 so that a real postIcon call (which uses
// small numbers and is ignored here anyway) can never be mistaken for one.
//
// This file also holds the rest of those two namespaces (all no-ops here).

#include "pxt.h"

#include <math.h>
#include <stdlib.h>

namespace ImageMethods {
int getPixel(Image_ img, int x, int y);
}
namespace pxt {
Image_ mkImage(int width, int height, int bpp);
}
using pxt::mkImage;

static int accelResult[2];
static uint32_t numberParts[2]; // halves of a number passed by __accelSetNumber
static Image_ accelImage;       // image result (read with getCurrentImage)
static bool accelImageRooted;

static double passedNumber() {
    double d;
    memcpy(&d, numberParts, 8);
    return d;
}

static void setResultImage(Image_ img) {
    if (!accelImageRooted) {
        registerGC((TValue *)&accelImage);
        accelImageRooted = true;
    }
    accelImage = img;
}

static inline int px(Image_ img, int x, int y) {
    if (x < 0 || y < 0 || x >= img->width() || y >= img->height())
        return 0;
    return (img->pix()[x * img->byteHeight() + (y >> 1)] >> ((y & 1) << 2)) & 0xf;
}

static inline void setPx(Image_ img, int x, int y, int c) {
    uint8_t *p = img->pix() + x * img->byteHeight() + (y >> 1);
    if (y & 1)
        *p = (*p & 0x0f) | (c << 4);
    else
        *p = (*p & 0xf0) | c;
}

// pxt-scaling's scale3x, step for step (edge pixels repeat the nearest
// inside pixel).
static Image_ scale3x(Image_ im) {
    int width = im->width(), height = im->height();
    Image_ out = mkImage(width * 3, height * 3, 4);
    for (int x = 0; x < width; ++x) {
        bool lb = x == 0, rb = x == width - 1;
        for (int y = 0; y < height; ++y) {
            bool tb = y == 0, bb = y == height - 1;
            int e = px(im, x, y);
            int b = tb ? e : px(im, x, y - 1);
            int d = lb ? e : px(im, x - 1, y);
            int f = rb ? e : px(im, x + 1, y);
            int h = bb ? e : px(im, x, y + 1);
            int ox = x * 3, oy = y * 3;
            if (b != h && d != f) {
                int a = (tb && lb) ? e : tb ? d : lb ? b : px(im, x - 1, y - 1);
                int c = (tb && rb) ? e : tb ? f : rb ? b : px(im, x + 1, y - 1);
                int g = (bb && lb) ? e : bb ? d : lb ? h : px(im, x - 1, y + 1);
                int i = (bb && rb) ? e : bb ? f : rb ? h : px(im, x + 1, y + 1);
                setPx(out, ox, oy, d == b ? d : e);
                setPx(out, ox + 1, oy, ((d == b && e != c) || (b == f && e != a)) ? b : e);
                setPx(out, ox + 2, oy, b == f ? f : e);
                setPx(out, ox, oy + 1, ((d == b && e != g) || (d == h && e != a)) ? d : e);
                setPx(out, ox + 1, oy + 1, e);
                setPx(out, ox + 2, oy + 1, ((b == f && e != i) || (h == f && e != c)) ? f : e);
                setPx(out, ox, oy + 2, d == h ? d : e);
                setPx(out, ox + 1, oy + 2, ((d == h && e != i) || (h == f && e != g)) ? h : e);
                setPx(out, ox + 2, oy + 2, h == f ? f : e);
            } else {
                for (int dx = 0; dx < 3; ++dx)
                    for (int dy = 0; dy < 3; ++dy)
                        setPx(out, ox + dx, oy + dy, e);
            }
        }
    }
    return out;
}

// pxt-scaling's rotSprite: enlarge 3x, rotate each pixel back to where it
// came from (same double-precision maths as the game code; positions are
// rounded toward zero like the runtime's number-to-int conversion), then
// shrink back with the most common colour of each 3x3 block (ties go to the
// higher colour number; colour 0 only if the block has nothing else).
static void rotSprite(Image_ im, double deg) {
    Image_ scaled = scale3x(im);
    registerGCObj(scaled);
    int w = scaled->width(), h = scaled->height();
    Image_ rotated = mkImage(w, h, 4);
    registerGCObj(rotated);
    double rad = (deg / 180) * M_PI;
    int midX = w >> 1, midY = h >> 1;

    // Each pixel's angle and distance from the centre only depend on the image
    // size, so they are worked out once per size and kept (with their cos/sin).
    struct PolarPixel {
        double theta, m, cosT, sinT;
    };
    static PolarPixel *polar;
    static int polarW = -1, polarH = -1;
    if (w != polarW || h != polarH) {
        free(polar);
        polar = (PolarPixel *)malloc(sizeof(PolarPixel) * (size_t)w * h);
        for (int x = 0; x < w; ++x)
            for (int y = 0; y < h; ++y) {
                int xDiff = x - midX, yDiff = y - midY;
                PolarPixel &p = polar[(size_t)x * h + y];
                p.theta = atan2((double)yDiff, (double)xDiff);
                p.m = sqrt((double)(xDiff * xDiff + yDiff * yDiff));
                p.cosT = cos(p.theta);
                p.sinT = sin(p.theta);
            }
        polarW = w;
        polarH = h;
    }

    // cos(theta - rad) = cos(theta)cos(rad) + sin(theta)sin(rad), and the same
    // for sin. That is off from the game code's exact cos()/sin() only in the
    // last few binary digits, which can change the result only when a position
    // lands within a hair of a whole number - so those (rare) pixels are done
    // the exact way, and every pixel comes out the same as in the original.
    double cosR = cos(rad), sinR = sin(rad);
    const double NEAR = 1e-7;
    for (int x = 0; x < w; ++x) {
        const PolarPixel *p = &polar[(size_t)x * h];
        for (int y = 0; y < h; ++y, ++p) {
            double sx = midX + p->m * (p->cosT * cosR + p->sinT * sinR);
            double sy = midY + p->m * (p->sinT * cosR - p->cosT * sinR);
            // (int) rounds toward zero, like the runtime; positions here are
            // small, so this is exact. frac is in (-1, 1).
            double fx = sx - (int)sx, fy = sy - (int)sy;
            if (fabs(fx) < NEAR || fabs(fx) > 1 - NEAR || fabs(fy) < NEAR || fabs(fy) > 1 - NEAR) {
                double angle = p->theta - rad;
                sx = midX + p->m * cos(angle);
                sy = midY + p->m * sin(angle);
            }
            setPx(rotated, x, y, px(scaled, (int)sx, (int)sy));
        }
    }
    Image_ out = mkImage(w / 3, h / 3, 4);
    for (int x = 0; x < w / 3; ++x)
        for (int y = 0; y < h / 3; ++y) {
            int counts[16] = {0};
            for (int dx = 0; dx < 3; ++dx)
                for (int dy = 0; dy < 3; ++dy)
                    counts[px(rotated, x * 3 + dx, y * 3 + dy)]++;
            int best = 1;
            for (int i = 1; i <= 15; ++i)
                if (counts[i] >= counts[best])
                    best = i;
            setPx(out, x, y, counts[best] ? best : 0);
        }
    unregisterGCObj(rotated);
    unregisterGCObj(scaled);
    setResultImage(out);
}

#define ACCEL_IMAGE_BOUNDS 0x3d50001
#define ACCEL_NUMBER_LO 0x3d50002
#define ACCEL_NUMBER_HI 0x3d50003
#define ACCEL_ROTSPRITE 0x3d50004
#define ACCEL_SET_SLOT 0x3d50005
#define ACCEL_LIGHT_ROW 0x3d50006
#define ACCEL_RING_ROW 0x3d50007

namespace Math_ {
TNumber randomRange(TNumber min, TNumber max);
}
namespace ImageMethods {
void setPixel(Image_ img, int x, int y, int c);
}

// Numbers kept for helpers that take several (set with ACCEL_SET_SLOT).
static double slots[4];

// The runtime's conversion of a number to a whole number (what "| 0" and
// passing a number to getPixel/setPixel do): drop the fraction, wrap to 32 bits.
// (Same steps as the runtime's toUInt for a fractional number, without
// allocating one.)
static inline int toInt32(double d) {
    if (!isnormal(d))
        return 0;
    if (d > -2147483648.0 && d < 2147483648.0)
        return (int)d; // a C cast drops the fraction, like trunc
    double t = trunc(d);
    double rem = fmod(t, 4294967296.0);
    if (rem < 0.0)
        rem += 4294967296.0;
    return (int)(unsigned)rem;
}

// The flicker amount as a runtime number (kept, so it is made only once).
static TValue shiverValue;
static bool shiverRooted;

// lanterns' changeRowLightLevel: each pixel from x to x + width becomes the
// darker of its current light level and lightLevel.
// (Pixels outside the image are skipped, as getPixel/setPixel do.)
static void changeRowLightLevel(Image_ img, double x, double y, double width, int lightLevel) {
    int start = toInt32(x), end = toInt32(width + x), yi = toInt32(y);
    if (img->bpp() != 4) { // not expected; do it the general way
        for (int x0 = start; x0 < end; x0++) {
            int current = ImageMethods::getPixel(img, x0, yi);
            ImageMethods::setPixel(img, x0, yi, lightLevel < current ? lightLevel : current);
        }
        return;
    }
    if (yi < 0 || yi >= img->height())
        return;
    if (start < 0)
        start = 0;
    if (end > img->width())
        end = img->width();
    if (start >= end)
        return;
    img->makeWritable();
    int bh = img->byteHeight(), shift = (yi & 1) << 2;
    uint8_t *p = img->pix() + start * bh + (yi >> 1);
    for (int x0 = start; x0 < end; x0++, p += bh) {
        int current = (*p >> shift) & 0xf;
        int c = (lightLevel < current ? lightLevel : current) & 0xf;
        *p = shift ? (*p & 0x0f) | (c << 4) : (*p & 0xf0) | c;
    }
}

// One ring row of a lanterns circle light's setup(). Slots: 0 = cx, 1 = cy.
static void ringRow(Image_ img, int packed) {
    unsigned u = (unsigned)packed;
    int prev = u & 0xff, offset = (u >> 8) & 0xff, band = (u >> 16) & 0x3f, y = u >> 22;
    double cx = slots[0], cy = slots[1];
    double yBottom = cy + y + 1, yTop = cy - y;
    changeRowLightLevel(img, cx + offset, yBottom, prev - offset, band);
    changeRowLightLevel(img, cx - prev, yBottom, prev - offset, band);
    changeRowLightLevel(img, cx + offset, yTop, prev - offset, band);
    changeRowLightLevel(img, cx - prev, yTop, prev - offset, band);
    if (band == 0) {
        changeRowLightLevel(img, cx, yBottom, prev, 0);
        changeRowLightLevel(img, cx - prev, yBottom, prev, 0);
        changeRowLightLevel(img, cx, yTop, prev, 0);
        changeRowLightLevel(img, cx - prev, yTop, prev, 0);
    }
}

// One flickering ring row of a lanterns circle light. Slots: 0 = cx, 1 = cy,
// 2 = shiver. Same order of random numbers as the game code.
static void lightRow(Image_ img, int packed) {
    int prev = packed & 0xff, band = (packed >> 8) & 0xff, y = packed >> 16;
    double cx = slots[0], cy = slots[1];
    double rand = pxt::toDouble(Math_::randomRange(fromInt(0), shiverValue));
    double xRight = cx + prev, xLeft = cx - prev - rand;
    double yBottom = cy + y + 1, yTop = cy - y;
    changeRowLightLevel(img, xRight, yBottom, rand, band);
    changeRowLightLevel(img, xLeft, yBottom, rand, band);
    changeRowLightLevel(img, xRight, yTop, rand, band);
    changeRowLightLevel(img, xLeft, yTop, rand, band);
}

// Finds the smallest box around an image's visible (non-zero) pixels.
// Result 0: (last column << 16 | first column), or -1 if nothing is visible.
// Result 1: (last row << 16 | first row).
static void imageBounds(Image_ img) {
    accelResult[0] = accelResult[1] = -1;
    if (!img)
        return;
    int w = img->width(), h = img->height();
    int left = w, right = -1, top = h, bottom = -1;

    static uint8_t rowBits[1024];
    int usedBytes = (h + 1) / 2; // bytes of each column that hold real pixels
    if (img->bpp() == 4 && usedBytes <= (int)sizeof(rowBits)) {
        // Fast way for 16-colour images (stored column by column, two pixels
        // per byte): a column is empty if all its bytes are zero, and OR-ing
        // every column together shows which rows have something in them.
        memset(rowBits, 0, usedBytes);
        int colBytes = img->byteHeight();
        uint8_t lastMask = (h & 1) ? 0x0f : 0xff; // odd height: half of the last byte is padding
        const uint8_t *col = img->pix();
        for (int x = 0; x < w; ++x, col += colBytes) {
            uint8_t any = 0;
            for (int i = 0; i < usedBytes - 1; ++i) {
                any |= col[i];
                rowBits[i] |= col[i];
            }
            uint8_t last = col[usedBytes - 1] & lastMask;
            any |= last;
            rowBits[usedBytes - 1] |= last;
            if (any) {
                if (x < left)
                    left = x;
                right = x;
            }
        }
        for (int y = 0; y < h; ++y)
            if ((rowBits[y >> 1] >> ((y & 1) << 2)) & 0xf) {
                if (y < top)
                    top = y;
                bottom = y;
            }
    } else {
        for (int x = 0; x < w; ++x)
            for (int y = 0; y < h; ++y)
                if (ImageMethods::getPixel(img, x, y)) {
                    if (x < left)
                        left = x;
                    if (x > right)
                        right = x;
                    if (y < top)
                        top = y;
                    if (y > bottom)
                        bottom = y;
                }
    }
    if (right < 0)
        return;
    accelResult[0] = (right << 16) | left;
    accelResult[1] = (bottom << 16) | top;
}

namespace multiplayer {

void postImage(Image_ im) {}

void postIcon(int type, int icon, Image_ im) {
    switch (type) {
    case ACCEL_IMAGE_BOUNDS:
        imageBounds(im);
        break;
    case ACCEL_NUMBER_LO:
        numberParts[0] = (uint32_t)icon;
        break;
    case ACCEL_NUMBER_HI:
        numberParts[1] = (uint32_t)icon;
        break;
    case ACCEL_SET_SLOT:
        if (icon >= 0 && icon < 4)
            slots[icon] = passedNumber();
        if (icon == 2) {
            if (!shiverRooted) {
                registerGC(&shiverValue);
                shiverRooted = true;
            }
            shiverValue = fromDouble(slots[2]);
        }
        break;
    case ACCEL_RING_ROW:
        if (im)
            ringRow(im, icon);
        break;
    case ACCEL_LIGHT_ROW:
        if (im)
            lightRow(im, icon);
        break;
    case ACCEL_ROTSPRITE:
        if (im && im->bpp() == 4)
            rotSprite(im, passedNumber());
        else
            setResultImage(NULL);
        break;
    }
}

void setOrigin(String origin) {}

Image_ getCurrentImage() {
    Image_ r = accelImage;
    accelImage = NULL; // hand it over; the game holds it from here
    return r;
}

String getOrigin() {
    return NULL;
}

} // namespace multiplayer

namespace Keyboard {

void promptForText(int maxLength, bool numberOnly) {}

void cancelTextPrompt() {}

char *getTextPromptString() {
    return NULL;
}

char *getLocalizedInstructions() {
    return NULL;
}

int getTextPromptSelectionStart() {
    return accelResult[0];
}

int getTextPromptSelectionEnd() {
    return accelResult[1];
}

bool isSystemKeyboardSupported() {
    return false;
}

} // namespace Keyboard
