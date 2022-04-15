import { Adapter } from '@sveltejs/kit';

interface AdapterOptions {
	pages?: string;
	assets?: string;
	fallback?: string;
	precompress?: boolean;
	importPrefix?: string;
	meta?: Record<string, any>;
}

declare function plugin(options?: AdapterOptions): Adapter;
export = plugin;
