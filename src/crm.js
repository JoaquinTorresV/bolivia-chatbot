// Bolivia usa Zernio, que no tiene el CRM de contactos/tags de YCloud.
// El takeover (derivación a humano) se maneja solo en la BD: setTakeover / isTakeover
// y el endpoint /admin/takeover. Estas funciones quedan como no-op para no romper los
// imports existentes del bot. Si Zernio expone una gestión de contactos equivalente,
// se puede implementar aquí más adelante.
export async function upsertContact(_phoneNumber, _nickname) { /* no-op en Zernio */ }
export async function setHumanTag(_phoneNumber, _active)      { /* no-op en Zernio */ }
export async function getContactById(_id)                     { return null; }
