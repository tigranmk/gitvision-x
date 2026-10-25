import { mount } from 'svelte';
import '@gvx/ui-tokens/src/tokens.css';
import '@vscode/codicons/dist/codicon.css';
import type { TimelineHostEvents, TimelineHostMethods } from '@gvx/protocol';
import { connect } from '@gvx/webview-shared';
import App from './App.svelte';

mount(App, { target: document.getElementById('app')!, props: { rpc: connect<TimelineHostMethods, TimelineHostEvents>() } });
