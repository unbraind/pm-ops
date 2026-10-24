/** Bounded reads for package inputs, including caller-selected artifacts and repository files. */
import { constants, openSync, closeSync, fstatSync, statSync, readSync } from "node:fs";
/** Sanitized input refusal shared by file consumers. */
export class InputRefusal extends Error {
    /** Stable machine-readable classification. */
    code = "invalid_input";
    /** Recovery instruction independent of the supplied path. */
    remedy;
    /** Invalid input is a usage error. */
    exitCode = 2;
    /** Whether the file is unsupported or could not be inspected. */
    reason;
    /** Construct without retaining paths or operating-system diagnostics. */
    constructor(limit, reason = "unsupported") {
        const remedy = `Supply a readable regular file no larger than ${limit} bytes; pipes, sockets, devices and directories are unsupported.`;
        super(`invalid_input: ${remedy}`);
        this.name = "InputRefusal";
        this.remedy = remedy;
        this.reason = reason;
    }
}
/** Read a regular file with preflight and descriptor checks, bounded allocation and nonblocking open. */
export function readRegularInput(path, limit = 16 * 1024 * 1024) {
    try {
        const before = statSync(path);
        if (!before.isFile() || before.size > limit)
            throw new InputRefusal(limit);
        const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
            const opened = fstatSync(fd);
            if (!opened.isFile() || opened.size > limit || opened.dev !== before.dev || opened.ino !== before.ino)
                throw new InputRefusal(limit);
            const buffer = Buffer.alloc(opened.size + 1);
            let offset = 0;
            while (offset < buffer.length) {
                const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
                if (count === 0)
                    break;
                offset += count;
            }
            if (offset > opened.size)
                throw new InputRefusal(limit);
            return buffer.subarray(0, offset);
        }
        finally {
            closeSync(fd);
        }
    }
    catch (error) {
        if (error instanceof InputRefusal)
            throw error;
        throw new InputRefusal(limit, "unreadable");
    }
}
/** Decode bounded regular input as UTF-8 for existing text parsers. */
export function readRegularText(path, limit) {
    return readRegularInput(path, limit).toString("utf8");
}
//# sourceMappingURL=regular-input.js.map