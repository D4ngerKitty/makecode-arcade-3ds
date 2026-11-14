// 3DS: the doorway into native helpers in player/source/accel.cpp.
// MakeCode only lets game code call runtime functions it already knows, so
// these borrow three that do nothing on this platform: __accelCall(op, arg,
// image) runs helper number "op", and the two __accelResult functions read
// back what it worked out.
//% shim=multiplayer::postIcon
declare function __accelCall(op: number, arg: number, im: Image): void;
//% shim=Keyboard::getTextPromptSelectionStart
declare function __accelResult0(): number;
//% shim=Keyboard::getTextPromptSelectionEnd
declare function __accelResult1(): number;
//% shim=multiplayer::getCurrentImage
declare function __accelImage(): Image;

// Passes a number to the native helpers exactly (all 64 bits), for helpers
// that need a fractional value: __accelCall only carries whole numbers.
let __accelNoImage: Image = null;
function __accelSetNumber(value: number) {
    const b = control.createBuffer(8);
    b.setNumber(NumberFormat.Float64LE, 0, value);
    // (Native calls may not be given null for an image, so pass a tiny one.)
    if (!__accelNoImage) __accelNoImage = image.create(1, 1);
    __accelCall(0x3d50002, b.getNumber(NumberFormat.Int32LE, 0), __accelNoImage);
    __accelCall(0x3d50003, b.getNumber(NumberFormat.Int32LE, 4), __accelNoImage);
}

namespace game {
    export class Hitbox {
        hash: number;
        parent: Sprite;
        ox: Fx8;
        oy: Fx8;
        width: Fx8;
        height: Fx8;

        constructor(parent: Sprite, width: Fx8, height: Fx8, ox: Fx8, oy: Fx8) {
            this.hash = parent.calcDimensionalHash();
            this.parent = parent;
            this.width = width;
            this.height = height;
            this.ox = ox;
            this.oy = oy;
        }

        get left() {
            return Fx.add(this.ox, this.parent._x);
        }

        get top() {
            return Fx.add(this.oy, this.parent._y);
        }

        get right() {
            return Fx.sub(
                Fx.add(this.width, this.left),
                Fx.oneFx8
            );
        }

        get bottom() {
            return Fx.sub(
                Fx.add(this.height, this.top),
                Fx.oneFx8
            );
        }

        isValid() {
            return this.hash === this.parent.calcDimensionalHash();
        }

        contains(x: Fx8, y: Fx8): boolean {
            return (x >= this.left) && (x <= this.right) && (y >= this.top) && (y <= this.bottom);
        }

        updateIfInvalid() {
            if (this.isValid())
                return;

            const newHitBox = game.calculateHitBox(this.parent);

            const oMinX = this.ox;
            const oMinY = this.oy;
            const oMaxX = Fx.add(oMinX, this.width);
            const oMaxY = Fx.add(oMinY, this.height);

            const nMinX = newHitBox.ox;
            const nMinY = newHitBox.oy;
            const nMaxX = Fx.add(nMinX, newHitBox.width);
            const nMaxY = Fx.add(nMinY, newHitBox.height);

            // total diff in x / y corners between the two hitboxes
            const xDiff = Fx.add(
                Fx.abs(Fx.sub(oMinX, nMinX)),
                Fx.abs(Fx.sub(oMaxX, nMaxX))
            );
            const yDiff = Fx.add(
                Fx.abs(Fx.sub(oMinY, nMinY)),
                Fx.abs(Fx.sub(oMaxY, nMaxY))
            );

            // If it's just a small change to the hitbox on one axis,
            // don't change the dimensions to avoid random clipping
            if (xDiff > Fx.twoFx8) {
                this.ox = nMinX;
                this.width = newHitBox.width;
            }
            if (yDiff > Fx.twoFx8) {
                this.oy = nMinY;
                this.height = newHitBox.height;
            }
            this.hash = newHitBox.hash;
        }

        overlapsWith(other: Hitbox): boolean {
            this.updateIfInvalid();
            other.updateIfInvalid();
            if (
                this.left > other.right ||
                this.top > other.bottom ||
                this.right < other.left ||
                this.bottom < other.top
            ) {
                return false;
            }
            return true;
        }
    }


    export function calculateHitBox(s: Sprite): Hitbox {
        if (s._hitbox && s._hitbox.isValid())
            return s._hitbox;

        if (s._rotatedBBox) {
            return new Hitbox(s, Fx8(s._rotatedBBox.width), Fx8(s._rotatedBBox.height), Fx.zeroFx8, Fx.zeroFx8);
        }

        const i = s.image;
        let minX = Fx8(i.width);
        let minY = Fx8(i.height);
        let maxX = Fx.zeroFx8;
        let maxY = Fx.zeroFx8;

        // Helper 1: result 0 is (last << 16 | first) column with a visible
        // pixel, or -1 for an empty image; result 1 is the same for rows.
        __accelCall(0x3d50001, 0, i);
        const boundsX = __accelResult0();
        if (boundsX >= 0) {
            const boundsY = __accelResult1();
            minX = Fx8(boundsX & 0xffff);
            maxX = Fx8(boundsX >> 16);
            minY = Fx8(boundsY & 0xffff);
            maxY = Fx8(boundsY >> 16);
        }

        minX = Fx.mul(minX, s._sx);
        minY = Fx.mul(minY, s._sy);
        maxX = Fx.mul(maxX, s._sx);
        maxY = Fx.mul(maxY, s._sy);
        const width  = Fx.add(Fx.sub(maxX, minX), s._sx);
        const height = Fx.add(Fx.sub(maxY, minY), s._sy);

        return new Hitbox(s, width, height, Fx.floor(minX), Fx.floor(minY));
    }
}