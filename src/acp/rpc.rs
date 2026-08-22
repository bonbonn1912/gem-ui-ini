use crate::processes::NdjsonLineGuard;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};

const DEFAULT_MAX_LINE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RpcError {
    #[error("ACP transport is closed")]
    Closed,
    #[error("ACP I/O failed: {0}")]
    Io(String),
    #[error("ACP protocol error: {0}")]
    Protocol(String),
    #[error("ACP request failed ({code}): {message}")]
    Remote {
        code: i64,
        message: String,
        data: Option<Value>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcResponse {
    pub jsonrpc: String,
    pub id: Value,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<RpcResponseError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcResponseError {
    pub code: i64,
    pub message: String,
    #[serde(default)]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RpcInbound {
    Response(RpcResponse),
    Notification(RpcNotification),
    Request(RpcRequest),
    Closed(RpcError),
}

#[derive(Debug)]
enum Outbound {
    Request(RpcRequest),
    Notification(RpcNotification),
    Response(Value),
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, RpcError>>>>>;

/// A small JSON-RPC 2.0 client.  One reader task owns correlation of all
/// responses; callers only see a request future and an ordered inbound stream.
#[derive(Clone)]
pub struct AcpRpcClient {
    outbound: mpsc::Sender<Outbound>,
    inbound: mpsc::Sender<RpcInbound>,
    pending: Pending,
    next_id: Arc<AtomicU64>,
    closed: Arc<AtomicBool>,
}

impl AcpRpcClient {
    pub fn new<R, W>(reader: R, writer: W) -> (Self, mpsc::Receiver<RpcInbound>)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self::with_max_line_bytes(reader, writer, DEFAULT_MAX_LINE_BYTES)
    }

    pub fn with_max_line_bytes<R, W>(
        reader: R,
        writer: W,
        max_line_bytes: usize,
    ) -> (Self, mpsc::Receiver<RpcInbound>)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (outbound_tx, mut outbound_rx) = mpsc::channel::<Outbound>(64);
        let (inbound_tx, inbound_rx) = mpsc::channel::<RpcInbound>(64);
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let client = Self {
            outbound: outbound_tx,
            inbound: inbound_tx.clone(),
            pending: Arc::clone(&pending),
            next_id: Arc::new(AtomicU64::new(1)),
            closed: Arc::clone(&closed),
        };

        let writer_client = client.clone();
        tokio::spawn(async move {
            let mut writer = writer;
            while let Some(message) = outbound_rx.recv().await {
                let value = match message {
                    Outbound::Request(request) => serde_json::to_value(request),
                    Outbound::Notification(notification) => serde_json::to_value(notification),
                    Outbound::Response(value) => Ok(value),
                };
                let mut bytes = match value {
                    Ok(value) => match serde_json::to_vec(&value) {
                        Ok(bytes) => bytes,
                        Err(error) => {
                            writer_client
                                .close(RpcError::Protocol(error.to_string()))
                                .await;
                            return;
                        }
                    },
                    Err(error) => {
                        writer_client
                            .close(RpcError::Protocol(error.to_string()))
                            .await;
                        return;
                    }
                };
                bytes.push(b'\n');
                if let Err(error) = writer.write_all(&bytes).await {
                    writer_client.close(RpcError::Io(error.to_string())).await;
                    return;
                }
                if let Err(error) = writer.flush().await {
                    writer_client.close(RpcError::Io(error.to_string())).await;
                    return;
                }
            }
        });

        let reader_client = client.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(reader);
            let mut guard = match NdjsonLineGuard::new(max_line_bytes) {
                Ok(guard) => guard,
                Err(error) => {
                    reader_client
                        .close(RpcError::Protocol(error.to_string()))
                        .await;
                    return;
                }
            };
            let mut line = Vec::new();
            loop {
                line.clear();
                match read_guarded_line(&mut reader, &mut guard, &mut line).await {
                    Ok(true) => {}
                    Ok(false) => {
                        reader_client.close(RpcError::Closed).await;
                        return;
                    }
                    Err(error) => {
                        reader_client.close(error).await;
                        return;
                    }
                }
                while line
                    .last()
                    .is_some_and(|byte| *byte == b'\n' || *byte == b'\r')
                {
                    line.pop();
                }
                if line.is_empty() {
                    continue;
                }
                let value: Value = match serde_json::from_slice(&line) {
                    Ok(value) => value,
                    Err(error) => {
                        reader_client
                            .close(RpcError::Protocol(error.to_string()))
                            .await;
                        return;
                    }
                };
                if let Err(error) = dispatch_inbound(value, &reader_client, &inbound_tx).await {
                    reader_client.close(error).await;
                    return;
                }
            }
        });
        (client, inbound_rx)
    }

    pub async fn request(
        &self,
        method: impl Into<String>,
        params: Value,
    ) -> Result<Value, RpcError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(RpcError::Closed);
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let id_value = Value::from(id);
        let key = id_key(&id_value);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(key.clone(), sender);
        let request = RpcRequest {
            jsonrpc: "2.0".to_owned(),
            id: id_value,
            method: method.into(),
            params,
        };
        if self
            .outbound
            .send(Outbound::Request(request))
            .await
            .is_err()
        {
            self.pending.lock().await.remove(&key);
            return Err(RpcError::Closed);
        }
        receiver.await.map_err(|_| RpcError::Closed)?
    }

    pub async fn notify(&self, method: impl Into<String>, params: Value) -> Result<(), RpcError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(RpcError::Closed);
        }
        self.outbound
            .send(Outbound::Notification(RpcNotification {
                jsonrpc: "2.0".to_owned(),
                method: method.into(),
                params,
            }))
            .await
            .map_err(|_| RpcError::Closed)
    }

    /// Answers an ACP server request (for example `session/request_permission`).
    pub async fn respond(
        &self,
        id: Value,
        result: Result<Value, RpcResponseError>,
    ) -> Result<(), RpcError> {
        let value = match result {
            Ok(result) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": error }),
        };
        self.outbound
            .send(Outbound::Response(value))
            .await
            .map_err(|_| RpcError::Closed)
    }

    pub async fn close(&self, reason: RpcError) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let mut pending = self.pending.lock().await;
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(reason.clone()));
        }
        drop(pending);
        let _ = self.inbound.try_send(RpcInbound::Closed(reason));
    }
}

async fn read_guarded_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    guard: &mut NdjsonLineGuard,
    line: &mut Vec<u8>,
) -> Result<bool, RpcError> {
    loop {
        // Inspect the BufRead window before copying it into `line`. Using
        // `read_until` here would allocate an arbitrarily large malicious
        // line first and only apply the configured guard afterwards.
        let buffer = reader
            .fill_buf()
            .await
            .map_err(|error| RpcError::Io(error.to_string()))?;
        if buffer.is_empty() {
            return Ok(!line.is_empty());
        }
        let take = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(buffer.len(), |index| index + 1);
        let ends_line = buffer[take - 1] == b'\n';
        guard
            .process(&buffer[..take])
            .map_err(|error| RpcError::Protocol(error.to_string()))?;
        line.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        if ends_line {
            return Ok(true);
        }
    }
}

async fn dispatch_inbound(
    value: Value,
    client: &AcpRpcClient,
    inbound: &mpsc::Sender<RpcInbound>,
) -> Result<(), RpcError> {
    let object = value
        .as_object()
        .ok_or_else(|| RpcError::Protocol("JSON-RPC message must be an object".to_owned()))?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(RpcError::Protocol(
            "JSON-RPC message must use protocol version 2.0".to_owned(),
        ));
    }
    let has_method = object.get("method").and_then(Value::as_str).is_some();
    let has_id = object.contains_key("id");
    if has_method {
        if has_id {
            let request: RpcRequest = serde_json::from_value(Value::Object(object.clone()))
                .map_err(|error| RpcError::Protocol(error.to_string()))?;
            inbound
                .send(RpcInbound::Request(request))
                .await
                .map_err(|_| RpcError::Closed)?;
        } else {
            let notification: RpcNotification =
                serde_json::from_value(Value::Object(object.clone()))
                    .map_err(|error| RpcError::Protocol(error.to_string()))?;
            inbound
                .send(RpcInbound::Notification(notification))
                .await
                .map_err(|_| RpcError::Closed)?;
        }
        return Ok(());
    }
    if has_id && (object.contains_key("result") || object.contains_key("error")) {
        let response: RpcResponse = serde_json::from_value(Value::Object(object.clone()))
            .map_err(|error| RpcError::Protocol(error.to_string()))?;
        let key = id_key(&response.id);
        let sender = client.pending.lock().await.remove(&key);
        if let Some(sender) = sender {
            let result = match response.error.clone() {
                Some(error) => Err(RpcError::Remote {
                    code: error.code,
                    message: error.message,
                    data: error.data,
                }),
                None => Ok(response.result.clone().unwrap_or(Value::Null)),
            };
            let _ = sender.send(result);
        }
        inbound
            .send(RpcInbound::Response(response))
            .await
            .map_err(|_| RpcError::Closed)?;
        return Ok(());
    }
    Err(RpcError::Protocol(
        "JSON-RPC message has neither method nor response".to_owned(),
    ))
}

fn id_key(id: &Value) -> String {
    serde_json::to_string(id).unwrap_or_else(|_| "null".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[tokio::test]
    async fn correlates_out_of_order_responses_and_delivers_notifications() {
        let (client_io, server_io) = duplex(4096);
        let (client_reader, client_writer) = tokio::io::split(client_io);
        let (server_reader, mut server_writer) = tokio::io::split(server_io);
        let mut server_reader = BufReader::new(server_reader);
        let (client, mut inbound) = AcpRpcClient::new(client_reader, client_writer);
        let first = {
            let client = client.clone();
            tokio::spawn(async move { client.request("first", serde_json::json!({})).await })
        };
        let second = {
            let client = client.clone();
            tokio::spawn(async move { client.request("second", serde_json::json!({})).await })
        };
        let mut requests = Vec::new();
        for _ in 0..2 {
            let mut bytes = Vec::new();
            server_reader.read_until(b'\n', &mut bytes).await.unwrap();
            requests.push(serde_json::from_slice::<RpcRequest>(&bytes).unwrap());
        }
        for request in requests.iter().rev() {
            let line = serde_json::to_vec(
                &serde_json::json!({"jsonrpc":"2.0","id":request.id,"result":request.method}),
            )
            .unwrap();
            server_writer
                .write_all(&[line, vec![b'\n']].concat())
                .await
                .unwrap();
        }
        assert_eq!(first.await.unwrap().unwrap(), Value::String("first".into()));
        assert_eq!(
            second.await.unwrap().unwrap(),
            Value::String("second".into())
        );
        server_writer
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{}}\n")
            .await
            .unwrap();
        assert!(matches!(
            inbound.recv().await,
            Some(RpcInbound::Response(_))
        ));
        assert!(matches!(
            inbound.recv().await,
            Some(RpcInbound::Response(_))
        ));
        assert!(matches!(
            inbound.recv().await,
            Some(RpcInbound::Notification(_))
        ));
    }

    #[tokio::test]
    async fn rejects_an_oversized_line_before_copying_it_to_the_message_buffer() {
        let (client_io, mut server_io) = duplex(64);
        server_io.write_all(b"abcd\n").await.unwrap();
        let mut reader = BufReader::new(client_io);
        let mut guard = NdjsonLineGuard::new(3).unwrap();
        let mut line = Vec::new();

        let result = read_guarded_line(&mut reader, &mut guard, &mut line).await;

        assert!(matches!(result, Err(RpcError::Protocol(_))));
        assert!(line.is_empty());
    }
}
