import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceLocator, WorkspaceRuntime } from "./runtime.js";

export const INPUT_FILE_MAX_BYTES = 25 * 1024 * 1024;
export type WorkspaceInputFile = { id: string; size: number; sha256: string };

export function inputFilePath(id: string, root = "/workspace") {
  if (!/^infile_[a-z0-9]{16,64}$/.test(id)) throw new Error("input_file_id_invalid");
  return `${root}/.facility/inputs/${id}`;
}

export function verifyInputBytes(file: WorkspaceInputFile, bytes: Buffer) {
  inputFilePath(file.id);
  if (
    bytes.length !== file.size ||
    bytes.length > INPUT_FILE_MAX_BYTES ||
    createHash("sha256").update(bytes).digest("hex") !== file.sha256
  )
    throw new Error("input_file_integrity_failed");
}

/** Only metadata reaches command arguments/stdout. Bytes use provider file APIs. */
export async function transferInputFile(
  runtime: WorkspaceRuntime,
  workspace: WorkspaceLocator,
  operation: "publish" | "export" | "remove",
  file: WorkspaceInputFile,
  transport: {
    write(path: string, bytes: Buffer): Promise<void>;
    read(path: string): Promise<Buffer>;
  },
  bytes?: Buffer,
) {
  inputFilePath(file.id);
  if (bytes) verifyInputBytes(file, bytes);
  const stage = `/tmp/facility-input-${randomUUID()}`;
  const root = runtime.provider === "fake" ? workspace.volumeRef : "/workspace";
  try {
    if (bytes) await transport.write(stage, bytes);
    const result = await runtime.exec(workspace, {
      command: "python3",
      args: [
        "-c",
        INPUT_FILE_OPERATION,
        operation,
        root,
        file.id,
        stage,
        String(file.size),
        file.sha256,
      ],
      resume: false,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) throw new Error("input_file_storage_failed");
    if (operation !== "export") return Buffer.alloc(0);
    const value = await transport.read(stage);
    verifyInputBytes(file, value);
    return value;
  } finally {
    await runtime
      .exec(workspace, {
        command: "python3",
        args: [
          "-c",
          "import os,sys; os.unlink(sys.argv[1]) if os.path.exists(sys.argv[1]) else None",
          stage,
        ],
        resume: false,
        timeoutMs: 10_000,
      })
      .catch(() => undefined);
  }
}

// Walk trusted directories using directory FDs, never following a symlink.
// The file ID is server-generated; original filenames never become paths.
export const INPUT_FILE_OPERATION = `
import hashlib, os, re, stat, sys
op, root, ident, stage, size, digest = sys.argv[1:]
size = int(size)
assert op in ('publish','export','remove') and re.fullmatch(r'infile_[a-z0-9]{16,64}', ident)
assert re.fullmatch(r'/tmp/facility-input-[a-f0-9-]{36}', stage)
assert 0 < size <= 25*1024*1024 and re.fullmatch(r'[a-f0-9]{64}', digest)
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
fds = [os.open(root, flags)]
try:
  for part in ('.facility','inputs'):
    try: os.mkdir(part, 0o700, dir_fd=fds[-1])
    except FileExistsError: pass
    fds.append(os.open(part, flags, dir_fd=fds[-1]))
  parent = fds[-1]
  if op == 'remove':
    for name in (ident, ident + '.partial'):
      try: os.unlink(name, dir_fd=parent)
      except FileNotFoundError: pass
  else:
    source = os.open(stage, os.O_RDONLY | os.O_NOFOLLOW) if op == 'publish' else os.open(ident, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
    try:
      info = os.fstat(source)
      assert stat.S_ISREG(info.st_mode) and info.st_size == size
      content = b''
      while len(content) <= size:
        chunk = os.read(source, min(1024*1024, size+1-len(content)))
        if not chunk: break
        content += chunk
      assert len(content) == size and hashlib.sha256(content).hexdigest() == digest
    finally: os.close(source)
    temp = ident + '.partial'
    target = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent) if op == 'publish' else os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
      with os.fdopen(target, 'wb') as output:
        output.write(content); output.flush(); os.fsync(output.fileno())
        if op == 'publish': os.fchmod(output.fileno(), 0o444)
      if op == 'publish': os.link(temp, ident, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
    finally:
      if op == 'publish': os.unlink(temp, dir_fd=parent)
finally:
  for fd in reversed(fds): os.close(fd)
`;

/** A single regular tar entry for Docker's binary archive API. */
export function inputFileArchive(path: string, bytes: Buffer) {
  const header = Buffer.alloc(512);
  const name = path.split("/").at(-1) ?? "";
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write("ustar\0", 257);
  header.write("00", 263);
  const sum = header.reduce((n, b) => n + b, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, bytes, Buffer.alloc(((512 - (bytes.length % 512)) % 512) + 1024)]);
}

export async function readInputArchive(
  stream: AsyncIterable<Buffer | string>,
  expectedPath: string,
) {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const part of stream) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    length += chunk.length;
    if (length > INPUT_FILE_MAX_BYTES + 65536) throw new Error("input_file_too_large");
    parts.push(chunk);
  }
  const tar = Buffer.concat(parts);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0/g, "").trim(), 8);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > INPUT_FILE_MAX_BYTES ||
      offset + 512 + size > tar.length
    )
      throw new Error("input_file_archive_invalid");
    const type = String.fromCharCode(header[156] ?? 0);
    if (type === "0" || type === "\0") {
      const name = header.subarray(0, 100).toString().split("\0")[0];
      if (name !== expectedPath.split("/").at(-1)) throw new Error("input_file_archive_invalid");
      return tar.subarray(offset + 512, offset + 512 + size);
    }
    if (type !== "x" && type !== "g") throw new Error("input_file_archive_invalid");
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("input_file_archive_invalid");
}
