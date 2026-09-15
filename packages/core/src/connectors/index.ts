/**
 * Xacheus Connect — connector catalogue.
 *
 * Add a connector in one place: implement it, drop it in this array, and its
 * operations immediately become permission-gated tools the agents can plan with.
 * Nothing else in the kernel changes.
 */
import type { ConfigStore } from '../config.js';
import { ConnectorRegistry } from './registry.js';
import { cloudinaryConnector } from './cloudinary.js';
import { customConnector } from './custom.js';
import { deviceConnector } from './device.js';
import { facebookConnector, instagramConnector, whatsappConnector } from './meta.js';
import { firebaseConnector } from './firebase.js';
import { homeConnector } from './home.js';
import { mailConnector } from './mail.js';
import { webConnector } from './web.js';

export * from './types.js';
export { ConnectorRegistry } from './registry.js';
export { uploadToCloudinary, isCloudinaryReady, cloudinaryFrom } from './cloudinary.js';
export { extractReadable } from './web.js';

export function createConnectorRegistry(config: ConfigStore): ConnectorRegistry {
  const registry = new ConnectorRegistry(config);
  registry.registerAll([
    facebookConnector,
    instagramConnector,
    whatsappConnector,
    mailConnector,
    homeConnector,
    cloudinaryConnector,
    firebaseConnector,
    webConnector,
    deviceConnector,
    customConnector,
  ]);
  return registry;
}
