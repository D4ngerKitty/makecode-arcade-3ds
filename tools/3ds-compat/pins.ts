// The native build used for the 3DS has no "pins" hardware library, but
// extensions commonly use pins.createBuffer just to allocate memory.
namespace pins {
    export function createBuffer(size: number): Buffer {
        return control.createBuffer(size);
    }
}
