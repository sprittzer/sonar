package com.tania.calculator;

import android.Manifest;
import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.util.Log;

import androidx.annotation.Nullable;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(
    name = "Mesh",
    permissions = {
        @Permission(
            strings = {
                Manifest.permission.INTERNET,
                Manifest.permission.ACCESS_WIFI_STATE,
                Manifest.permission.ACCESS_NETWORK_STATE,
                Manifest.permission.CHANGE_WIFI_MULTICAST_STATE
            },
            alias = "meshNet"
        )
    }
)
public class MeshPlugin extends Plugin {

    private static final String TAG = "MeshPlugin";
    private static final String MDNS_TYPE = "_hexmesh._udp.";

    private final Map<String, Peer> peers = new ConcurrentHashMap<>();
    private final Set<String> seenMessageIds = Collections.newSetFromMap(new ConcurrentHashMap<>());

    private volatile boolean running = false;
    private String nodeId = "";
    private String displayName = "User";
    private int udpPort = 41234;
    private List<String> capabilities = new ArrayList<>();

    private DatagramSocket socket;
    private Thread receiverThread;
    private ScheduledExecutorService scheduler;

    private NsdManager nsdManager;
    private NsdManager.RegistrationListener registrationListener;
    private NsdManager.DiscoveryListener discoveryListener;
    private WifiManager.MulticastLock multicastLock;

    @PluginMethod
    public void start(PluginCall call) {
        if (running) {
            call.resolve();
            return;
        }

        nodeId = call.getString("nodeId", "n-" + UUID.randomUUID().toString().substring(0, 8));
        displayName = call.getString("displayName", "User");
        udpPort = call.getInt("udpPort", 41234);
        capabilities = parseCapabilities(call.getArray("capabilities"));

        try {
            setupSocket();
            setupMulticastLock();
            startReceiver();
            startSchedulers();
            startMdns();
            running = true;
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to start mesh", e);
            call.reject("Failed to start mesh: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        shutdownMesh();
        call.resolve();
    }

    @PluginMethod
    public void getPeers(PluginCall call) {
        JSObject result = new JSObject();
        result.put("peers", peersToArray());
        call.resolve(result);
    }

    @PluginMethod
    public void sendPacket(PluginCall call) {
        JSObject envelopeObj = call.getObject("envelope");
        if (envelopeObj == null) {
            call.reject("Missing envelope");
            return;
        }

        try {
            JSONObject envelope = new JSONObject(envelopeObj.toString());
            normalizeEnvelope(envelope);
            sendMeshEnvelope(envelope, null, -1);
            call.resolve();
        } catch (Exception e) {
            call.reject("sendPacket failed: " + e.getMessage());
        }
    }

    private void setupSocket() throws Exception {
        socket = new DatagramSocket(null);
        socket.setReuseAddress(true);
        socket.bind(new InetSocketAddress(udpPort));
        socket.setBroadcast(true);
    }

    private void setupMulticastLock() {
        Context context = getContext();
        if (context == null) return;
        WifiManager wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
        if (wifiManager == null) return;

        multicastLock = wifiManager.createMulticastLock("hexmesh-mdns-lock");
        multicastLock.setReferenceCounted(true);
        multicastLock.acquire();
    }

    private void startReceiver() {
        receiverThread = new Thread(() -> {
            byte[] buffer = new byte[65507];
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                    socket.receive(packet);
                    String text = new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.UTF_8);
                    processIncoming(text, packet.getAddress(), packet.getPort());
                } catch (Exception e) {
                    if (running) {
                        Log.w(TAG, "Receiver loop exception", e);
                    }
                }
            }
        });
        receiverThread.setName("hexmesh-udp-receiver");
        receiverThread.start();
    }

    private void startSchedulers() {
        scheduler = Executors.newScheduledThreadPool(2);
        scheduler.scheduleAtFixedRate(this::broadcastHello, 200, 1500, TimeUnit.MILLISECONDS);
        scheduler.scheduleAtFixedRate(this::prunePeers, 3, 3, TimeUnit.SECONDS);
    }

    private void startMdns() {
        try {
            nsdManager = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
            if (nsdManager == null) return;

            NsdServiceInfo serviceInfo = new NsdServiceInfo();
            serviceInfo.setServiceName("hex-" + nodeId.substring(0, Math.min(6, nodeId.length())));
            serviceInfo.setServiceType(MDNS_TYPE);
            serviceInfo.setPort(udpPort);

            registrationListener = new NsdManager.RegistrationListener() {
                @Override
                public void onServiceRegistered(NsdServiceInfo NsdServiceInfo) {}

                @Override
                public void onRegistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {
                    Log.w(TAG, "mDNS registration failed: " + errorCode);
                }

                @Override
                public void onServiceUnregistered(NsdServiceInfo arg0) {}

                @Override
                public void onUnregistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {}
            };

            discoveryListener = new NsdManager.DiscoveryListener() {
                @Override
                public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                    Log.w(TAG, "mDNS discovery start failed: " + errorCode);
                }

                @Override
                public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                    Log.w(TAG, "mDNS discovery stop failed: " + errorCode);
                }

                @Override
                public void onDiscoveryStarted(String serviceType) {}

                @Override
                public void onDiscoveryStopped(String serviceType) {}

                @Override
                public void onServiceFound(NsdServiceInfo serviceInfo) {
                    if (!MDNS_TYPE.equals(serviceInfo.getServiceType())) return;
                    if (serviceInfo.getServiceName().startsWith("hex-" + nodeId.substring(0, Math.min(6, nodeId.length())))) return;

                    try {
                        nsdManager.resolveService(serviceInfo, new NsdManager.ResolveListener() {
                            @Override
                            public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {}

                            @Override
                            public void onServiceResolved(NsdServiceInfo resolved) {
                                InetAddress host = resolved.getHost();
                                int port = resolved.getPort();
                                if (host != null && port > 0) {
                                    sendHelloTo(host, port);
                                }
                            }
                        });
                    } catch (Exception ignored) {
                        // Some Android versions throw if resolve is called too frequently.
                    }
                }

                @Override
                public void onServiceLost(NsdServiceInfo serviceInfo) {}
            };

            nsdManager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, registrationListener);
            nsdManager.discoverServices(MDNS_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
        } catch (Exception e) {
            Log.w(TAG, "mDNS init failed", e);
        }
    }

    private void stopMdns() {
        if (nsdManager == null) return;
        try {
            if (registrationListener != null) nsdManager.unregisterService(registrationListener);
        } catch (Exception ignored) {}
        try {
            if (discoveryListener != null) nsdManager.stopServiceDiscovery(discoveryListener);
        } catch (Exception ignored) {}

        registrationListener = null;
        discoveryListener = null;
        nsdManager = null;
    }

    private List<String> parseCapabilities(@Nullable JSArray arr) {
        List<String> list = new ArrayList<>();
        if (arr == null) return list;
        for (int i = 0; i < arr.length(); i++) {
            try {
                list.add(arr.getString(i));
            } catch (JSONException ignored) {}
        }
        return list;
    }

    private void processIncoming(String text, InetAddress sourceAddress, int sourcePort) {
        try {
            JSONObject root = new JSONObject(text);
            String kind = root.optString("kind", "");

            if ("HELLO".equals(kind)) {
                onHello(root, sourceAddress, sourcePort, true);
                return;
            }

            if ("HELLO_ACK".equals(kind)) {
                onHello(root, sourceAddress, sourcePort, false);
                return;
            }

            if ("MESH".equals(kind)) {
                JSONObject envelope = root.optJSONObject("envelope");
                if (envelope == null) return;
                onMeshEnvelope(envelope, sourceAddress, sourcePort);
            }
        } catch (Exception ignored) {
            // Ignore non-mesh packets
        }
    }

    private void onHello(JSONObject hello, InetAddress sourceAddress, int sourcePort, boolean shouldAck) {
        String remoteNodeId = hello.optString("nodeId", "");
        String remoteDisplayName = hello.optString("displayName", remoteNodeId);
        int remotePort = hello.optInt("port", sourcePort);
        if (remoteNodeId.isEmpty() || remoteNodeId.equals(nodeId)) return;

        JSONArray capsArray = hello.optJSONArray("capabilities");
        List<String> caps = new ArrayList<>();
        if (capsArray != null) {
            for (int i = 0; i < capsArray.length(); i++) {
                caps.add(capsArray.optString(i));
            }
        }

        Peer peer = new Peer(remoteNodeId, remoteDisplayName, sourceAddress.getHostAddress(), remotePort, caps);
        peers.put(remoteNodeId, peer);
        emitPeersUpdate();

        if (shouldAck) {
            sendHelloAckTo(sourceAddress, remotePort);
        }
    }

    private synchronized void onMeshEnvelope(JSONObject envelope, InetAddress sourceAddress, int sourcePort) {
        String msgId = envelope.optString("msgId", "");
        if (msgId.isEmpty()) return;

        if (seenMessageIds.contains(msgId)) return;
        seenMessageIds.add(msgId);

        if (seenMessageIds.size() > 10000) {
            seenMessageIds.clear();
        }

        String to = envelope.optString("to", "*");
        boolean forMe = to.equals("*") || to.equals(nodeId);

        if (forMe) {
            JSObject payload = new JSObject();
            payload.put("envelope", envelope.toString());
            notifyListeners("meshPacket", payload);
        }

        int ttl = envelope.optInt("ttl", 0);
        if (ttl <= 0) return;

        if (!to.equals(nodeId)) {
            try {
                JSONObject forwarded = new JSONObject(envelope.toString());
                forwarded.put("ttl", ttl - 1);
                sendMeshEnvelope(forwarded, sourceAddress, sourcePort);
            } catch (JSONException ignored) {}
        }
    }

    private void normalizeEnvelope(JSONObject envelope) throws JSONException {
        if (!envelope.has("msgId") || envelope.optString("msgId", "").isEmpty()) {
            envelope.put("msgId", "m-" + UUID.randomUUID());
        }
        if (!envelope.has("from") || envelope.optString("from", "").isEmpty()) {
            envelope.put("from", nodeId);
        }
        if (!envelope.has("ttl")) {
            envelope.put("ttl", 8);
        }
        if (!envelope.has("to")) {
            envelope.put("to", "*");
        }
    }

    private void sendMeshEnvelope(JSONObject envelope, @Nullable InetAddress excludeAddress, int excludePort) {
        try {
            JSONObject wrapper = new JSONObject();
            wrapper.put("kind", "MESH");
            wrapper.put("envelope", envelope);
            byte[] data = wrapper.toString().getBytes(StandardCharsets.UTF_8);

            String to = envelope.optString("to", "*");
            if (!"*".equals(to) && peers.containsKey(to)) {
                Peer target = peers.get(to);
                if (target != null) {
                    sendDatagram(data, target.address, target.port);
                }
                return;
            }

            for (Peer peer : peers.values()) {
                if (excludeAddress != null && peer.address.equals(excludeAddress.getHostAddress()) && peer.port == excludePort) {
                    continue;
                }
                sendDatagram(data, peer.address, peer.port);
            }
        } catch (Exception e) {
            Log.w(TAG, "sendMeshEnvelope failed", e);
        }
    }

    private void broadcastHello() {
        if (!running) return;

        try {
            JSONObject hello = buildHello("HELLO");
            byte[] data = hello.toString().getBytes(StandardCharsets.UTF_8);
            sendDatagram(data, "255.255.255.255", udpPort);

            for (Peer peer : peers.values()) {
                sendDatagram(data, peer.address, peer.port);
            }
        } catch (Exception e) {
            Log.w(TAG, "broadcastHello failed", e);
        }
    }

    private void sendHelloTo(InetAddress host, int port) {
        try {
            JSONObject hello = buildHello("HELLO");
            byte[] data = hello.toString().getBytes(StandardCharsets.UTF_8);
            sendDatagram(data, host.getHostAddress(), port);
        } catch (Exception ignored) {}
    }

    private void sendHelloAckTo(InetAddress host, int port) {
        try {
            JSONObject hello = buildHello("HELLO_ACK");
            byte[] data = hello.toString().getBytes(StandardCharsets.UTF_8);
            sendDatagram(data, host.getHostAddress(), port);
        } catch (Exception ignored) {}
    }

    private JSONObject buildHello(String kind) throws JSONException {
        JSONObject hello = new JSONObject();
        hello.put("kind", kind);
        hello.put("nodeId", nodeId);
        hello.put("displayName", displayName);
        hello.put("port", udpPort);
        JSONArray caps = new JSONArray();
        for (String c : capabilities) {
            caps.put(c);
        }
        hello.put("capabilities", caps);
        return hello;
    }

    private void sendDatagram(byte[] data, String host, int port) {
        try {
            if (socket == null || socket.isClosed()) return;
            DatagramPacket packet = new DatagramPacket(data, data.length, InetAddress.getByName(host), port);
            socket.send(packet);
        } catch (Exception ignored) {}
    }

    private void prunePeers() {
        long now = System.currentTimeMillis();
        boolean changed = false;

        List<String> ids = new ArrayList<>(peers.keySet());
        for (String id : ids) {
            Peer p = peers.get(id);
            if (p == null) continue;
            if (now - p.lastSeenMs > 10000) {
                peers.remove(id);
                changed = true;
            }
        }

        if (changed) {
            emitPeersUpdate();
        }
    }

    private JSArray peersToArray() {
        JSArray arr = new JSArray();
        for (Peer p : peers.values()) {
            JSObject obj = new JSObject();
            obj.put("nodeId", p.nodeId);
            obj.put("displayName", p.displayName);
            obj.put("address", p.address);
            obj.put("port", p.port);
            obj.put("lastSeenMs", p.lastSeenMs);

            JSArray caps = new JSArray();
            for (String c : p.capabilities) {
                caps.put(c);
            }
            obj.put("capabilities", caps);
            arr.put(obj);
        }
        return arr;
    }

    private void emitPeersUpdate() {
        JSObject event = new JSObject();
        event.put("peers", peersToArray());
        notifyListeners("peersUpdate", event);
    }

    private void shutdownMesh() {
        running = false;

        if (receiverThread != null) {
            receiverThread.interrupt();
            receiverThread = null;
        }

        if (scheduler != null) {
            scheduler.shutdownNow();
            scheduler = null;
        }

        if (socket != null) {
            try {
                socket.close();
            } catch (Exception ignored) {}
            socket = null;
        }

        stopMdns();

        if (multicastLock != null && multicastLock.isHeld()) {
            multicastLock.release();
            multicastLock = null;
        }

        peers.clear();
        seenMessageIds.clear();
        emitPeersUpdate();
    }

    @Override
    protected void handleOnDestroy() {
        shutdownMesh();
        super.handleOnDestroy();
    }

    private static class Peer {
        String nodeId;
        String displayName;
        String address;
        int port;
        long lastSeenMs;
        List<String> capabilities;

        Peer(String nodeId, String displayName, String address, int port, List<String> capabilities) {
            this.nodeId = nodeId;
            this.displayName = displayName;
            this.address = address;
            this.port = port;
            this.capabilities = capabilities;
            this.lastSeenMs = System.currentTimeMillis();
        }
    }
}
