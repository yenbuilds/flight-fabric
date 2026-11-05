import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { loadMobileVoiceIdentity } from './mobile-voice-identity';
export declare function createMobileVoiceService({ httpServer, port, ips, directory, token, pairing, upgradeTelemetry, identityLoader, initiallyEnabled, saveEnabled, }: {
    httpServer: Server;
    port: number;
    ips: string[];
    directory: string;
    token: string;
    pairing: {
        hasApprovedSession: (id: unknown, address: string | null) => boolean;
    } | null;
    upgradeTelemetry: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
    identityLoader?: typeof loadMobileVoiceIdentity;
    initiallyEnabled?: boolean;
    saveEnabled?: (enabled: boolean) => void;
}): {
    handleHttp: (req: IncomingMessage, res: ServerResponse) => boolean;
    status: () => {
        enabled: boolean;
        preparing: boolean;
        error: string;
        available: boolean;
        port: number;
        fingerprint: string;
        urls: string[];
    };
    ready: Promise<void>;
    authorizeDispatch(id: unknown): boolean;
    dispose(): Promise<void>;
};
