package com.tania.calculator;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.ParcelUuid;
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
        ),
        @Permission(
            strings = {
                Manifest.permission.BLUETOOTH,
                Manifest.permission.BLUETOOTH_ADMIN,
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.ACCESS_FINE_LOCATION
            },
            alias = "meshBle"
        )
    }
)
public class MeshPlugin extends Plugin {

    private static final String TAG = "MeshPlugin";
    private static final String MDNS_TYPE = "_hexmesh._udp.";
    private static final String TRANSPORT_LAN = "lan";
    private static final String TRANSPORT_BLE = "ble"; // legacy alias
    private static final String TRANSPORT_BLUETOOTH = "bluetooth";
    private static final String TRANSPORT_HYBRID = "hybrid";
    private static final ParcelUuid BLE_SERVICE_UUID = ParcelUuid.fromString("12345678-1234-5678-1234-56789abc0001");
    private static final long HELLO_INTERVAL_MS = 2500;
    private static final int HELLO_BROADCAST_EVERY_TICKS = 4;
    private static final long PEER_TTL_MS = 20000;

    private final Map<String, Peer> peers = new ConcurrentHashMap<>();
    private final Set<String> seenMessageIds = Collections.newSetFromMap(new ConcurrentHashMap<>());

    private volatile boolean running = false;
    private String nodeId = "";
    private String displayName = "User";
    private String transportMode = TRANSPORT_LAN;
    private int udpPort = 41234;
    private List<String> capabilities = new ArrayList<>();

    private DatagramSocket socket;
    private Thread receiverThread;
    private ScheduledExecutorService scheduler;

    private NsdManager nsdManager;
    private NsdManager.RegistrationListener registrationListener;
    private NsdManager.DiscoveryListener discoveryListener;
    private WifiManager.MulticastLock multicastLock;

    private BluetoothAdapter bluetoothAdapter;
    private BluetoothLeAdvertiser bleAdvertiser;
    private BluetoothLeScanner bleScanner;
    private AdvertiseCallback bleAdvertiseCallback;
    private ScanCallback bleScanCallback;
    private int helloTick = 0;

    @PluginMethod
    public void start(PluginCall call) {
        if (running) {
            call.resolve();
            return;
        }

        nodeId = call.getString("nodeId", "n-" + UUID.randomUUID().toString().substring(0, 8));
        displayName = call.getString("displayName", "User");
        transportMode = call.getString("transport", TRANSPORT_LAN);
        if (TRANSPORT_BLE.equals(transportMode)) {
            transportMode = TRANSPORT_BLUETOOTH;
        }
        udpPort = call.getInt("udpPort", 41234);
        capabilities = parseCapabilities(call.getArray("capabilities"));

        try {
            if (isLanEnabled()) {
                setupSocket();
                setupMulticastLock();
                startReceiver();
                startSchedulers();
                startMdns();
            }
            if (isBleEnabled()) {
                startBle();
            }
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
        if (!isLanEnabled()) {
            call.reject("Bluetooth transport currently supports discovery only. Data packets require LAN/hybrid mode.");
            return;
        }

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
        scheduler.scheduleAtFixedRate(this::helloTick, 200, HELLO_INTERVAL_MS, TimeUnit.MILLISECONDS);
        scheduler.scheduleAtFixedRate(this::prunePeers, 3, 5, TimeUnit.SECONDS);
    }

    private boolean isLanEnabled() {
        return TRANSPORT_LAN.equals(transportMode) || TRANSPORT_HYBRID.equals(transportMode);
    }

    private boolean isBleEnabled() {
        return TRANSPORT_BLUETOOTH.equals(transportMode) || TRANSPORT_BLE.equals(transportMode) || TRANSPORT_HYBRID.equals(transportMode);
    }

    private void startBle() {
        try {
            Context context = getContext();
            if (context == null) return;

            BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
            if (manager == null) return;

            bluetoothAdapter = manager.getAdapter();
            if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
                emitError("Bluetooth выключен на устройстве.");
                return;
            }

            bleAdvertiser = bluetoothAdapter.getBluetoothLeAdvertiser();
            bleScanner = bluetoothAdapter.getBluetoothLeScanner();

            if (bleAdvertiser != null) startBleAdvertise();
            if (bleScanner != null) startBleScan();
        } catch (Exception e) {
            Log.w(TAG, "BLE init failed", e);
            emitError("BLE init failed: " + e.getMessage());
        }
    }

    private void startBleAdvertise() {
        byte[] payload = buildBlePayload();
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setConnectable(false)
            .setTimeout(0)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .build();

        AdvertiseData data = new AdvertiseData.Builder()
            .addServiceUuid(BLE_SERVICE_UUID)
            .addServiceData(BLE_SERVICE_UUID, payload)
            .build();

        bleAdvertiseCallback = new AdvertiseCallback() {
            @Override
            public void onStartFailure(int errorCode) {
                emitError("BLE advertise failed: " + errorCode);
            }
        };

        try {
            bleAdvertiser.startAdvertising(settings, data, bleAdvertiseCallback);
        } catch (SecurityException e) {
            emitError("BLE advertise permission denied: " + e.getMessage());
        }
    }

    private void startBleScan() {
        List<ScanFilter> filters = new ArrayList<>();
        filters.add(new ScanFilter.Builder().setServiceUuid(BLE_SERVICE_UUID).build());

        ScanSettings settings = new ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build();

        bleScanCallback = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                onBleScanResult(result);
            }

            @Override
            public void onBatchScanResults(List<ScanResult> results) {
                for (ScanResult r : results) onBleScanResult(r);
            }

            @Override
            public void onScanFailed(int errorCode) {
                emitError("BLE scan failed: " + errorCode);
            }
        };

        try {
            bleScanner.startScan(filters, settings, bleScanCallback);
        } catch (SecurityException e) {
            emitError("BLE scan permission denied: " + e.getMessage());
        }
    }

    private void onBleScanResult(ScanResult result) {
        if (result == null || result.getScanRecord() == null) return;
        byte[] data = result.getScanRecord().getServiceData(BLE_SERVICE_UUID);
        if (data == null || data.length == 0) return;

        String text = new String(data, StandardCharsets.UTF_8);
        String[] parts = text.split("\\|", 2);
        if (parts.length == 0) return;

        String remoteNodeId = parts[0];
        String remoteName = parts.length > 1 ? parts[1] : remoteNodeId;
        if (remoteNodeId.isEmpty() || remoteNodeId.equals(nodeId)) return;

        String address = result.getDevice() != null ? result.getDevice().getAddress() : "ble-unknown";
        List<String> caps = new ArrayList<>();
        caps.add("ble");
        Peer peer = new Peer(remoteNodeId, remoteName, "ble:" + address, -1, caps);
        peers.put(remoteNodeId, peer);
        emitPeersUpdate();
    }

    private byte[] buildBlePayload() {
        // Keep payload short for BLE service data.
        String compactName = displayName == null ? "User" : displayName;
        if (compactName.length() > 16) compactName = compactName.substring(0, 16);
        String compactNodeId = nodeId == null ? "n-unknown" : nodeId;
        if (compactNodeId.length() > 20) compactNodeId = compactNodeId.substring(0, 20);
        return (compactNodeId + "|" + compactName).getBytes(StandardCharsets.UTF_8);
    }

    private void stopBle() {
        try {
            if (bleAdvertiser != null && bleAdvertiseCallback != null) {
                bleAdvertiser.stopAdvertising(bleAdvertiseCallback);
            }
        } catch (Exception ignored) {}

        try {
            if (bleScanner != null && bleScanCallback != null) {
                bleScanner.stopScan(bleScanCallback);
            }
        } catch (Exception ignored) {}

        bleAdvertiseCallback = null;
        bleScanCallback = null;
        bleAdvertiser = null;
        bleScanner = null;
        bluetoothAdapter = null;
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

        Peer prev = peers.get(remoteNodeId);
        Peer peer = new Peer(remoteNodeId, remoteDisplayName, sourceAddress.getHostAddress(), remotePort, caps);
        peers.put(remoteNodeId, peer);

        boolean changed =
            prev == null ||
            !safeEquals(prev.displayName, peer.displayName) ||
            !safeEquals(prev.address, peer.address) ||
            prev.port != peer.port ||
            !safeEquals(String.valueOf(prev.capabilities), String.valueOf(peer.capabilities));
        if (changed) {
            emitPeersUpdate();
        }

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

    private void helloTick() {
        if (!running) return;
        helloTick++;
        sendHelloToKnownPeers();
        if (helloTick % HELLO_BROADCAST_EVERY_TICKS == 0 || peers.isEmpty()) {
            sendHelloBroadcast();
        }
    }

    private void sendHelloBroadcast() {
        if (!running) return;
        try {
            JSONObject hello = buildHello("HELLO");
            byte[] data = hello.toString().getBytes(StandardCharsets.UTF_8);
            sendDatagram(data, "255.255.255.255", udpPort);
        } catch (Exception e) {
            Log.w(TAG, "sendHelloBroadcast failed", e);
        }
    }

    private void sendHelloToKnownPeers() {
        if (!running) return;
        try {
            JSONObject hello = buildHello("HELLO");
            byte[] data = hello.toString().getBytes(StandardCharsets.UTF_8);
            for (Peer peer : peers.values()) {
                if (peer.port <= 0 || peer.address.startsWith("ble:")) continue;
                sendDatagram(data, peer.address, peer.port);
            }
        } catch (Exception e) {
            Log.w(TAG, "sendHelloToKnownPeers failed", e);
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
            if (now - p.lastSeenMs > PEER_TTL_MS) {
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
        helloTick = 0;

        if (socket != null) {
            try {
                socket.close();
            } catch (Exception ignored) {}
            socket = null;
        }

        stopMdns();
        stopBle();

        if (multicastLock != null && multicastLock.isHeld()) {
            multicastLock.release();
            multicastLock = null;
        }

        peers.clear();
        seenMessageIds.clear();
        emitPeersUpdate();
    }

    private void emitError(String message) {
        JSObject event = new JSObject();
        event.put("message", message);
        notifyListeners("error", event);
    }

    private boolean safeEquals(String a, String b) {
        if (a == null && b == null) return true;
        if (a == null || b == null) return false;
        return a.equals(b);
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
