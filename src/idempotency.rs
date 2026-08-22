use crate::db::DbPool;
use crate::error::AppError;
use rusqlite::OptionalExtension;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::future::Future;

#[derive(Clone)]
pub struct ClientRequestRepo {
    db: DbPool,
}

impl ClientRequestRepo {
    pub fn new(db: DbPool) -> Self {
        Self { db }
    }

    fn reserve(&self, client_request_id: &str, operation: &str) -> Result<Reservation, AppError> {
        let operation = operation.trim();
        if client_request_id.trim().is_empty()
            || operation.is_empty()
            || operation.chars().count() > 200
        {
            return Err(AppError::Validation(
                "clientRequestId is required and operation must contain 1 to 200 characters"
                    .to_owned(),
            ));
        }
        let connection = self.db.connection()?;
        let existing: Option<(String, Option<String>)> = connection
            .query_row(
                "SELECT operation, result_json FROM client_requests WHERE client_request_id = ?1",
                [client_request_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((existing_operation, result_json)) = existing {
            if existing_operation != operation {
                return Err(AppError::Conflict(format!(
                    "client request '{client_request_id}' was already used for another operation"
                )));
            }
            return match result_json {
                Some(result_json) => Ok(Reservation::Completed(result_json)),
                None => Err(AppError::Conflict(format!(
                    "client request '{client_request_id}' is already in progress"
                ))),
            };
        }
        connection.execute(
            "INSERT INTO client_requests (client_request_id, operation, result_json, created_at) VALUES (?1, ?2, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            (client_request_id, operation),
        )?;
        Ok(Reservation::New)
    }

    fn save<T: Serialize>(&self, client_request_id: &str, result: &T) -> Result<(), AppError> {
        let result_json = serde_json::to_string(result)?;
        let connection = self.db.connection()?;
        connection.execute(
            "UPDATE client_requests SET result_json = ?2 WHERE client_request_id = ?1",
            (client_request_id, result_json),
        )?;
        Ok(())
    }

    fn remove_pending(&self, client_request_id: &str) -> Result<(), AppError> {
        let connection = self.db.connection()?;
        connection.execute(
            "DELETE FROM client_requests WHERE client_request_id = ?1 AND result_json IS NULL",
            [client_request_id],
        )?;
        Ok(())
    }
}

enum Reservation {
    New,
    Completed(String),
}

/// Executes a write once per `client_request_id`, returning the persisted
/// response for retries. Failed actions release their reservation so callers
/// may retry after fixing a transient failure.
pub async fn idempotent<T, F, Fut>(
    repo: &ClientRequestRepo,
    client_request_id: &str,
    operation: &str,
    action: F,
) -> Result<T, AppError>
where
    T: Serialize + DeserializeOwned,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, AppError>>,
{
    match repo.reserve(client_request_id, operation)? {
        Reservation::Completed(result_json) => Ok(serde_json::from_str(&result_json)?),
        Reservation::New => match action().await {
            Ok(result) => {
                repo.save(client_request_id, &result)?;
                Ok(result)
            }
            Err(error) => {
                repo.remove_pending(client_request_id)?;
                Err(error)
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{idempotent, ClientRequestRepo};
    use crate::db::DbPool;
    use crate::error::AppError;
    use serde::{Deserialize, Serialize};
    use std::future::Future;
    use std::sync::Arc;
    use std::task::{Context, Poll, Wake, Waker};

    #[derive(Debug, Deserialize, PartialEq, Serialize)]
    struct ResultValue {
        value: u32,
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        struct Noop;
        impl Wake for Noop {
            fn wake(self: Arc<Self>) {}
        }
        let waker: Waker = Arc::new(Noop).into();
        let mut future = Box::pin(future);
        let mut context = Context::from_waker(&waker);
        loop {
            match future.as_mut().poll(&mut context) {
                Poll::Ready(value) => return value,
                Poll::Pending => std::thread::yield_now(),
            }
        }
    }

    #[test]
    fn retries_return_the_original_result_without_running_action() {
        let repo = ClientRequestRepo::new(DbPool::open_in_memory().unwrap());
        let mut runs = 0;
        let first = block_on(idempotent(
            &repo,
            "request-1",
            "projects:create",
            || async {
                runs += 1;
                Ok::<_, AppError>(ResultValue { value: 7 })
            },
        ))
        .unwrap();
        let second = block_on(idempotent(
            &repo,
            "request-1",
            "projects:create",
            || async {
                runs += 1;
                Ok::<_, AppError>(ResultValue { value: 99 })
            },
        ))
        .unwrap();
        assert_eq!(first, ResultValue { value: 7 });
        assert_eq!(second, ResultValue { value: 7 });
        assert_eq!(runs, 1);
    }

    #[test]
    fn failed_action_releases_reservation() {
        let repo = ClientRequestRepo::new(DbPool::open_in_memory().unwrap());
        let failed = block_on(idempotent(
            &repo,
            "request-2",
            "projects:create",
            || async { Err::<ResultValue, _>(AppError::Upstream("temporary".to_owned())) },
        ));
        assert!(failed.is_err());
        let retried = block_on(idempotent(
            &repo,
            "request-2",
            "projects:create",
            || async { Ok::<_, AppError>(ResultValue { value: 8 }) },
        ))
        .unwrap();
        assert_eq!(retried, ResultValue { value: 8 });
    }
}
