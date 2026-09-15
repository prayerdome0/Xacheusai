package ai.xacheus.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import ai.xacheus.app.MainActivity

private val Background = Color(0xFF07080F)
private val Surface = Color(0xFF131735)
private val Accent = Color(0xFF7C5CFF)
private val Muted = Color(0xFF9AA0C0)

/**
 * Single-screen app: status, conversation, approvals and pairing settings.
 * Kept deliberately small — the phone is a microphone, a speaker and a set of
 * device actions; the thinking happens on your backend.
 */
@Composable
fun XacheusScreen(
    serverUrl: String,
    onServerUrlChange: (String) -> Unit,
    token: String,
    onTokenChange: (String) -> Unit,
    deviceName: String,
    onDeviceNameChange: (String) -> Unit,
    paired: Boolean,
    status: String,
    listeningStatus: String,
    connected: Boolean,
    wakeEnabled: Boolean,
    speakReplies: Boolean,
    transcript: SnapshotStateList<MainActivity.Turn>,
    onSave: () -> Unit,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    onToggleWake: (Boolean) -> Unit,
    onSpeakChange: (Boolean) -> Unit,
    onMicPressed: () -> Unit,
    onSend: (String) -> Unit,
    onApprove: () -> Unit,
    onDecline: () -> Unit,
) {
    var showSettings by remember { mutableStateOf(!paired) }
    var draft by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Background)
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(12.dp)
                    .background(if (connected) Color(0xFF44D07B) else Color(0xFFF0A63A), CircleShape),
            )
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text("Xacheus", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = Color.White)
                Text(status, style = MaterialTheme.typography.bodySmall, color = Muted)
            }
            IconButton(onClick = { showSettings = !showSettings }) {
                Icon(Icons.Filled.Settings, contentDescription = "Settings", tint = Muted)
            }
        }

        if (showSettings) {
            SettingsCard(
                serverUrl = serverUrl,
                onServerUrlChange = onServerUrlChange,
                token = token,
                onTokenChange = onTokenChange,
                deviceName = deviceName,
                onDeviceNameChange = onDeviceNameChange,
                connected = connected,
                paired = paired,
                wakeEnabled = wakeEnabled,
                speakReplies = speakReplies,
                listeningStatus = listeningStatus,
                onSave = onSave,
                onConnect = onConnect,
                onDisconnect = onDisconnect,
                onToggleWake = onToggleWake,
                onSpeakChange = onSpeakChange,
            )
        }

        val listState = rememberLazyListState()
        LaunchedEffect(transcript.size) {
            if (transcript.isNotEmpty()) listState.animateScrollToItem(transcript.size - 1)
        }

        LazyColumn(
            state = listState,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (transcript.isEmpty()) {
                item {
                    Text(
                        "Say “Xacheus” followed by a request, or type below.\n\n" +
                            "Try: “Xacheus, what's on today?”, “Xacheus, open WhatsApp.”, “Xacheus, remind me at 8 to check the site.”",
                        color = Muted,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            items(transcript) { turn ->
                Bubble(fromOwner = turn.fromOwner, text = turn.text)
            }
        }

        if (transcript.isNotEmpty() && transcript.last().text.contains("approval", ignoreCase = true)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onApprove, modifier = Modifier.weight(1f)) { Text("Approve") }
                OutlinedButton(onClick = onDecline, modifier = Modifier.weight(1f)) { Text("Decline") }
            }
            Spacer(Modifier.height(8.dp))
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Ask Xacheus…") },
                maxLines = 4,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = {
                    onSend(draft)
                    draft = ""
                }),
            )
            Spacer(Modifier.width(8.dp))
            FilledIconButton(
                onClick = {
                    if (draft.isBlank()) onMicPressed() else {
                        onSend(draft)
                        draft = ""
                    }
                },
                modifier = Modifier.size(56.dp),
            ) {
                Icon(
                    if (draft.isBlank()) Icons.Filled.Mic else Icons.Filled.Send,
                    contentDescription = if (draft.isBlank()) "Speak" else "Send",
                )
            }
        }
        if (listeningStatus != "Idle") {
            Text(listeningStatus, color = Muted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp))
        }
    }
}

@Composable
private fun Bubble(fromOwner: Boolean, text: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (fromOwner) Arrangement.End else Arrangement.Start,
    ) {
        Card(
            colors = CardDefaults.cardColors(containerColor = if (fromOwner) Accent else Surface),
            shape = RoundedCornerShape(14.dp),
            modifier = Modifier.fillMaxWidth(0.88f),
        ) {
            Text(
                text,
                modifier = Modifier.padding(12.dp),
                color = Color.White,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun SettingsCard(
    serverUrl: String,
    onServerUrlChange: (String) -> Unit,
    token: String,
    onTokenChange: (String) -> Unit,
    deviceName: String,
    onDeviceNameChange: (String) -> Unit,
    connected: Boolean,
    paired: Boolean,
    wakeEnabled: Boolean,
    speakReplies: Boolean,
    listeningStatus: String,
    onSave: () -> Unit,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    onToggleWake: (Boolean) -> Unit,
    onSpeakChange: (Boolean) -> Unit,
) {
    Card(
        colors = CardDefaults.cardColors(containerColor = Surface),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 12.dp),
    ) {
        Column(
            Modifier
                .padding(14.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            Text("Pairing", color = Color.White, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = serverUrl,
                onValueChange = onServerUrlChange,
                label = { Text("Server URL") },
                placeholder = { Text("http://192.168.1.20:8787") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = token,
                onValueChange = onTokenChange,
                label = { Text("Device bridge token") },
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = deviceName,
                onValueChange = onDeviceNameChange,
                label = { Text("Device name") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onSave, modifier = Modifier.weight(1f)) { Text("Save & connect") }
                if (paired) {
                    OutlinedButton(onClick = if (connected) onDisconnect else onConnect, modifier = Modifier.weight(1f)) {
                        Text(if (connected) "Disconnect" else "Connect")
                    }
                }
            }

            Spacer(Modifier.height(14.dp))
            Divider(color = Color(0xFF262B4D))
            Spacer(Modifier.height(10.dp))
            Text("Voice", color = Color.White, fontWeight = FontWeight.SemiBold)
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) {
                    Text("Wake word “Xacheus”", color = Color.White)
                    Text(
                        "Runs as a foreground service with a visible notification. Android shows the mic indicator the whole time.",
                        color = Muted,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Switch(checked = wakeEnabled, onCheckedChange = onToggleWake)
            }
            if (listeningStatus.isNotBlank()) {
                Text(listeningStatus, color = Muted, style = MaterialTheme.typography.bodySmall)
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) {
                    Text("Speak replies", color = Color.White)
                    Text("Uses the phone's text-to-speech engine.", color = Muted, style = MaterialTheme.typography.bodySmall)
                }
                Switch(checked = speakReplies, onCheckedChange = onSpeakChange)
            }

            Spacer(Modifier.height(10.dp))
            TextButton(onClick = { }) {
                Text("Permissions are requested the first time Xacheus needs them.", color = Muted, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
