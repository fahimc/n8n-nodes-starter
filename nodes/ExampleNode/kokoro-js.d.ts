declare module 'kokoro-js' {
	export function init(config: any): void;
	export function start(): void;
	export function stop(): void;
	export function getStatus(): string;
	export const KokoroTTS: any;
}
