function producerPorts({ autoAck = true } = {}) {
  const ports = [];
  const connect = ({ name }) => {
    const messages = new Set(), disconnects = new Set();
    const port = { name, disconnected: false,
      onMessage: { addListener(fn) { messages.add(fn); }, removeListener(fn) { messages.delete(fn); } },
      onDisconnect: { addListener(fn) { disconnects.add(fn); }, removeListener(fn) { disconnects.delete(fn); } },
      receive(message) { for (const fn of [...messages]) fn(message); },
      disconnect() { if (this.disconnected) return; this.disconnected = true; for (const fn of [...disconnects]) fn(); },
    };
    ports.push(port);
    if (autoAck && name === 'mendosave-producer') queueMicrotask(() => port.receive({ ok: true, instanceId: 'processor-fixture' }));
    return port;
  };
  return { ports, connect };
}
module.exports = { producerPorts };
