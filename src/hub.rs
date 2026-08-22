use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, RwLock, Weak};

pub type SubscriptionId = u64;
type Callback<V> = dyn Fn(V) -> Result<(), ()> + Send + Sync + 'static;

struct Subscriber<K, V> {
    key: K,
    callback: Arc<Callback<V>>,
}

struct HubInner<K, V> {
    next_id: SubscriptionId,
    subscribers: HashMap<SubscriptionId, Subscriber<K, V>>,
}

/// Generic keyed subscription hub.
///
/// Commands can use `subscribe_channel` with a `tauri::ipc::Channel<V>`.
/// Keeping the callback core independently testable makes its fan-out and
/// lifecycle behavior straightforward to unit test.
pub struct SubscriptionHub<K, V> {
    inner: Arc<RwLock<HubInner<K, V>>>,
}

impl<K, V> Default for SubscriptionHub<K, V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<K, V> Clone for SubscriptionHub<K, V> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<K, V> SubscriptionHub<K, V> {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HubInner {
                next_id: 1,
                subscribers: HashMap::new(),
            })),
        }
    }
}

impl<K, V> SubscriptionHub<K, V>
where
    K: Eq + Hash + Clone,
    V: Clone,
{
    pub fn subscribe<F>(&self, key: K, callback: F) -> Subscription<K, V>
    where
        F: Fn(V) -> Result<(), ()> + Send + Sync + 'static,
    {
        let mut inner = self.inner.write().expect("subscription hub lock poisoned");
        let id = inner.next_id;
        inner.next_id += 1;
        inner.subscribers.insert(
            id,
            Subscriber {
                key,
                callback: Arc::new(callback),
            },
        );
        Subscription {
            id,
            hub: Arc::downgrade(&self.inner),
        }
    }

    pub fn subscribe_channel(&self, key: K, channel: tauri::ipc::Channel<V>) -> Subscription<K, V>
    where
        V: serde::Serialize + Send + Sync + 'static,
    {
        self.subscribe(key, move |value| channel.send(value).map_err(|_| ()))
    }

    pub fn unsubscribe(&self, id: SubscriptionId) -> bool {
        self.inner
            .write()
            .expect("subscription hub lock poisoned")
            .subscribers
            .remove(&id)
            .is_some()
    }

    /// Sends a value to all subscribers for `key`. Failed callbacks are
    /// removed, which is the expected behavior when a Tauri Channel owner has
    /// gone away.
    pub fn notify(&self, key: &K, value: V) -> usize {
        let subscribers = {
            let inner = self.inner.read().expect("subscription hub lock poisoned");
            inner
                .subscribers
                .iter()
                .filter(|(_, subscriber)| &subscriber.key == key)
                .map(|(id, subscriber)| (*id, Arc::clone(&subscriber.callback)))
                .collect::<Vec<_>>()
        };

        let mut delivered = 0;
        let mut failed = Vec::new();
        for (id, callback) in subscribers {
            if callback(value.clone()).is_ok() {
                delivered += 1;
            } else {
                failed.push(id);
            }
        }
        for id in failed {
            self.unsubscribe(id);
        }
        delivered
    }

    pub fn notify_with<F>(&self, key: &K, compute: F) -> usize
    where
        F: FnOnce(&K) -> V,
    {
        self.notify(key, compute(key))
    }

    pub fn subscriber_count(&self) -> usize {
        self.inner
            .read()
            .expect("subscription hub lock poisoned")
            .subscribers
            .len()
    }
}

pub struct Subscription<K, V> {
    id: SubscriptionId,
    hub: Weak<RwLock<HubInner<K, V>>>,
}

impl<K, V> Subscription<K, V> {
    pub const fn id(&self) -> SubscriptionId {
        self.id
    }
}

impl<K, V> Drop for Subscription<K, V> {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade() {
            if let Ok(mut inner) = hub.write() {
                inner.subscribers.remove(&self.id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SubscriptionHub;
    use std::sync::{Arc, Mutex};

    #[test]
    fn fans_out_by_key_and_unsubscribes_on_drop() {
        let hub = SubscriptionHub::<String, String>::new();
        let received = Arc::new(Mutex::new(Vec::new()));
        let copy = Arc::clone(&received);
        let subscription = hub.subscribe("project".to_owned(), move |value| {
            copy.lock().unwrap().push(value);
            Ok(())
        });
        assert_eq!(hub.notify(&"other".to_owned(), "ignored".to_owned()), 0);
        assert_eq!(hub.notify(&"project".to_owned(), "event".to_owned()), 1);
        assert_eq!(received.lock().unwrap().as_slice(), &["event"]);
        assert_eq!(hub.subscriber_count(), 1);
        drop(subscription);
        assert_eq!(hub.subscriber_count(), 0);
    }

    #[test]
    fn failed_channel_is_removed() {
        let hub = SubscriptionHub::<u8, u8>::new();
        let _subscription = hub.subscribe(1, |_| Err(()));
        assert_eq!(hub.notify(&1, 3), 0);
        assert_eq!(hub.subscriber_count(), 0);
    }
}
