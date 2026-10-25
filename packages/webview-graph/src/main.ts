import { mount } from 'svelte';
import '@gvx/ui-tokens/src/tokens.css';
import App from './App.svelte';
import { connect } from './rpc';

mount(App, { target: document.getElementById('app')!, props: { rpc: connect() } });
