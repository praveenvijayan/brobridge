/**
 * Message framing over a brobridge stream.
 *
 * A brobridge stream is an ordered byte channel, not a message channel: a
 * `write` may arrive as several chunks and several writes may arrive as one.
 * Every framework adapted here speaks in discrete messages, so each one is
 * length-prefixed on the way out and reassembled on the way in.
 *
 * The prefix is deliberately the same shape as the protocol's own header
 * fields: a kind byte, then a little-endian `u32` length. The kind is what
 * lets a framework that sends both text and binary — oRPC does — get back
 * exactly what it sent rather than a guess.
 *
 * @packageDocumentation
 */
import type { BridgeStream } from '@brobridgejs/core';

/** Bytes of framing that precede every message. */
export const MESSAGE_HEADER_SIZE = 5;

/**
 * The largest message this framing will emit or accept.
 *
 * Matches the protocol's own maximum frame size. The limit is what keeps a
 * peer's length prefix from becoming an allocation request.
 */
export const MAX_MESSAGE_SIZE = 16 * 1024 * 1024;

/** What a message's payload is, so the other side hands back the same type. */
export const MessageKind = {
  /** UTF-8 text. */
  text: 0,
  /** Opaque bytes. */
  binary: 1,
} as const;

/** One of {@link MessageKind}. */
export type MessageKind = (typeof MessageKind)[keyof typeof MessageKind];

/** A framed message. */
export interface Message {
  readonly kind: MessageKind;
  readonly payload: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Thrown when a peer's framing cannot be trusted. */
export class MessageFramingError extends Error {
  override readonly name = 'MessageFramingError';
}

/** Frame one message: header, then payload. */
export function frameMessage(kind: MessageKind, payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_MESSAGE_SIZE) {
    throw new MessageFramingError(
      `message of ${String(payload.length)} bytes exceeds the ${String(MAX_MESSAGE_SIZE)} byte limit`,
    );
  }
  const out = new Uint8Array(MESSAGE_HEADER_SIZE + payload.length);
  out[0] = kind;
  new DataView(out.buffer, out.byteOffset, MESSAGE_HEADER_SIZE).setUint32(1, payload.length, true);
  out.set(payload, MESSAGE_HEADER_SIZE);
  return out;
}

/**
 * Send one message.
 *
 * Header and payload go out in a single `write`, so the protocol's credit
 * accounting sees one logical unit and the promise settles only once the
 * whole message has been handed to the connection.
 */
export function writeMessage(
  stream: BridgeStream,
  kind: MessageKind,
  payload: Uint8Array,
): Promise<void> {
  return stream.write(frameMessage(kind, payload));
}

/** Send a value as a UTF-8 JSON message. */
export function writeJson(stream: BridgeStream, value: unknown): Promise<void> {
  return writeMessage(stream, MessageKind.text, encoder.encode(JSON.stringify(value)));
}

/**
 * Read framed messages until the stream ends.
 *
 * A stream that ends mid-message is a framing fault, not a clean close: the
 * consumer is told rather than left to assume it saw everything.
 */
export async function* readMessages(stream: BridgeStream): AsyncGenerator<Message> {
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  for await (const chunk of stream) {
    buffer = buffer.length === 0 ? chunk : concat(buffer, chunk);
    for (;;) {
      if (buffer.length < MESSAGE_HEADER_SIZE) break;
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const length = view.getUint32(1, true);
      if (length > MAX_MESSAGE_SIZE) {
        throw new MessageFramingError(
          `peer announced a ${String(length)} byte message, over the ${String(MAX_MESSAGE_SIZE)} byte limit`,
        );
      }
      if (buffer.length < MESSAGE_HEADER_SIZE + length) break;
      const kind = view.getUint8(0);
      if (kind !== MessageKind.text && kind !== MessageKind.binary) {
        throw new MessageFramingError(`unknown message kind ${String(kind)}`);
      }
      yield {
        kind,
        payload: buffer.slice(MESSAGE_HEADER_SIZE, MESSAGE_HEADER_SIZE + length),
      };
      buffer = buffer.subarray(MESSAGE_HEADER_SIZE + length);
    }
  }
  if (buffer.length !== 0) {
    throw new MessageFramingError('stream ended part-way through a message');
  }
}

/** Read framed JSON messages until the stream ends. */
export async function* readJson(stream: BridgeStream): AsyncGenerator<unknown> {
  for await (const message of readMessages(stream)) {
    if (message.kind !== MessageKind.text) {
      throw new MessageFramingError('expected a JSON message, got binary');
    }
    yield JSON.parse(decoder.decode(message.payload));
  }
}

/** Decode a message back to the type its sender used. */
export function decodeMessage(message: Message): string | Uint8Array {
  return message.kind === MessageKind.text ? decoder.decode(message.payload) : message.payload;
}

/** Frame whatever a framework handed us, keeping text and bytes distinct. */
export function encodeUnknown(data: unknown): Message {
  if (typeof data === 'string') {
    return { kind: MessageKind.text, payload: encoder.encode(data) };
  }
  if (data instanceof Uint8Array) return { kind: MessageKind.binary, payload: data };
  if (data instanceof ArrayBuffer) return { kind: MessageKind.binary, payload: new Uint8Array(data) };
  if (ArrayBuffer.isView(data)) {
    return {
      kind: MessageKind.binary,
      payload: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    };
  }
  throw new MessageFramingError(
    'a bridge carries text or bytes; this message is neither, so it cannot be sent unserialised',
  );
}

function concat(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}
