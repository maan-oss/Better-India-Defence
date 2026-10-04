import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createReadStream } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';

/**
 * Byte sources for the handlers: UDP (unicast, broadcast or multicast), TCP client (reconnecting), TCP
 * server (many senders), and file/device (serial devices configured with stty, or a recorded log replay).
 */
export type TransportConfig =
  | { type: 'udp'; port: number; bind?: string; multicast?: string; multicastInterface?: string }
  | { type: 'tcp-client'; host: string; port: number }
  | { type: 'tcp-server'; port: number; bind?: string }
  | { type: 'file'; path: string; /** Replay a recording at this many bytes per second (omit for a live device). */ bytesPerSecond?: number };

export interface Running {
  close(): Promise<void>;
  describe: string;
}

type OnData = (chunk: Buffer, peer: string) => void;
type Log = (m: string) => void;

export function startTransport(t: TransportConfig, onData: OnData, log: Log): Running {
  switch (t.type) {
    case 'udp': {
      const s: UdpSocket = createSocket({ type: 'udp4', reuseAddr: true });
      s.on('message', (msg, rinfo) => onData(msg, `${rinfo.address}:${rinfo.port}`));
      s.on('error', (e) => log(`udp ${t.port}: ${e.message}`));
      s.bind(t.port, t.bind ?? '0.0.0.0', () => {
        if (t.multicast) s.addMembership(t.multicast, t.multicastInterface);
      });
      return { describe: `udp ${t.bind ?? '0.0.0.0'}:${t.port}${t.multicast ? ` (multicast ${t.multicast})` : ''}`, close: () => new Promise((r) => s.close(() => r())) };
    }
    case 'tcp-client': {
      let sock: Socket | null = null;
      let closed = false;
      let wait = 1000;
      const open = () => {
        if (closed) return;
        sock = connect(t.port, t.host);
        sock.on('connect', () => {
          wait = 1000;
          log(`connected to ${t.host}:${t.port}`);
        });
        sock.on('data', (d) => onData(d, `${t.host}:${t.port}`));
        sock.on('error', (e) => log(`tcp ${t.host}:${t.port}: ${e.message}`));
        sock.on('close', () => {
          if (closed) return;
          setTimeout(open, wait).unref();
          wait = Math.min(30_000, wait * 2);
        });
      };
      open();
      return {
        describe: `tcp client ${t.host}:${t.port}`,
        close: async () => {
          closed = true;
          sock?.destroy();
        },
      };
    }
    case 'tcp-server': {
      const conns = new Set<Socket>();
      const srv: Server = createServer((c) => {
        conns.add(c);
        const peer = `${c.remoteAddress}:${c.remotePort}`;
        c.on('data', (d) => onData(d, peer));
        c.on('error', () => {});
        c.on('close', () => conns.delete(c));
      });
      srv.listen(t.port, t.bind ?? '0.0.0.0');
      return {
        describe: `tcp server ${t.bind ?? '0.0.0.0'}:${t.port}`,
        close: () =>
          new Promise((r) => {
            for (const c of conns) c.destroy();
            srv.close(() => r());
          }),
      };
    }
    case 'file': {
      const st = createReadStream(t.path, t.bytesPerSecond ? { highWaterMark: Math.max(64, Math.round(t.bytesPerSecond / 10)) } : {});
      if (t.bytesPerSecond) {
        st.on('data', (d) => {
          st.pause();
          onData(d as Buffer, t.path);
          setTimeout(() => st.resume(), ((d as Buffer).length / t.bytesPerSecond!) * 1000);
        });
      } else st.on('data', (d) => onData(d as Buffer, t.path));
      st.on('error', (e) => log(`${t.path}: ${e.message}`));
      st.on('end', () => log(`${t.path}: end of input`));
      return { describe: `file ${t.path}`, close: async () => void st.destroy() };
    }
  }
}

/** UDP / TCP sender for outbound CoT. */
export function sender(t: { type: 'udp' | 'tcp'; host: string; port: number }, log: Log): { send(data: string): void; close(): void } {
  if (t.type === 'udp') {
    const s = createSocket('udp4');
    return { send: (d) => s.send(Buffer.from(d), t.port, t.host, (e) => e && log(`cot out ${t.host}:${t.port}: ${e.message}`)), close: () => s.close() };
  }
  let sock: Socket | null = null;
  const ensure = () => {
    if (sock && !sock.destroyed) return sock;
    sock = connect(t.port, t.host);
    sock.on('error', (e) => log(`cot out ${t.host}:${t.port}: ${e.message}`));
    return sock;
  };
  return { send: (d) => void ensure().write(d), close: () => sock?.destroy() };
}
