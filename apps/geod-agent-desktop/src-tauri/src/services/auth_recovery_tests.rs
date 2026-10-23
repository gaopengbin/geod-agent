use super::*;

struct FixtureCredential(String);
impl Drop for FixtureCredential {
    fn drop(&mut self) { let _ = delete_tokens(&self.0); }
}

fn fixture_tokens(origin: &str, owner: &str) -> Tokens {
    Tokens { identity_origin: origin.into(), access_token: "a".repeat(43), refresh_token: "r".repeat(43), user_id: owner.into(), access_expires_at: unix_seconds() + 3600 }
}

fn spawn_waiter(flow: &Arc<Mutex<Flow>>, origin: &str, timeout: Duration) -> (String, thread::JoinHandle<()>) {
    let reservation = FlowReservation::acquire(flow).unwrap();
    let generation = reservation.generation;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let redirect = format!("http://{}/oauth/callback", listener.local_addr().unwrap());
    let url = redirect.clone();
    let config = ServiceConfig { identity_origin: origin.into(), gateway_origin: origin.into() };
    let flow = Arc::clone(flow);
    let handle = thread::spawn(move || complete_flow(listener, "recovery-fixture".into(), "test-verifier".into(), redirect, config, flow, Arc::new(Mutex::new(())), generation, timeout));
    reservation.transfer();
    (url, handle)
}

fn callback(url: &str) -> reqwest::blocking::Response {
    reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap()
        .get(format!("{url}?state=recovery-fixture&code={}", "c".repeat(43))).send().unwrap()
}

// Every test uses a new loopback identity / Windows vault entry. No production
// account, email verification, gateway, model, or telemetry endpoint is called.
fn provider() -> (String, thread::JoinHandle<()>, std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (received_tx, received_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let request = read_callback_headers(&mut stream).unwrap();
        assert!(request.starts_with("POST /api/geod/oauth/token "));
        received_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let body = json!({"access_token":"a".repeat(43),"refresh_token":"r".repeat(43),"user_id":"oauth-fixture","expires_in":3600}).to_string();
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    });
    (origin, handle, received_rx, release_tx)
}

#[test]
fn replacement_login_survives_old_preflight_failure_and_worker_timeout() {
    let flow = Arc::new(Mutex::new(Flow::default()));
    let mut old = FlowReservation::acquire(&flow).unwrap();
    let mut newer = FlowReservation::start(&flow, true).unwrap();
    assert_eq!(old.ensure_current().unwrap_err().code, "AUTH_SUPERSEDED");
    assert!(newer.ensure_current().is_ok());
    old.fail("stale browser error");
    assert!(flow.lock().unwrap().pending);
    assert!(flow.lock().unwrap().error.is_none());
    newer.finish();
    assert!(!flow.lock().unwrap().pending);

    let (unused, expired_worker) = spawn_waiter(&flow, "http://127.0.0.1:1", Duration::from_millis(50));
    let mut newest = FlowReservation::start(&flow, true).unwrap();
    expired_worker.join().unwrap();
    assert!(flow.lock().unwrap().pending);
    assert!(flow.lock().unwrap().error.is_none());
    assert!(reqwest::blocking::Client::builder().no_proxy().build().unwrap().get(unused).send().is_err());
    newest.finish();
}

#[cfg(windows)]
#[test]
fn timeout_then_new_callback_connects_without_recreating_the_application_state() {
    assert!(AUTH_WAIT_TIMEOUT >= Duration::from_secs(600));
    let (origin, server, received, release) = provider();
    let _cleanup = FixtureCredential(origin.clone());
    let flow = Arc::new(Mutex::new(Flow::default()));
    let (_, expired) = spawn_waiter(&flow, &origin, Duration::from_millis(30));
    expired.join().unwrap();
    assert!(!flow.lock().unwrap().pending);
    assert!(flow.lock().unwrap().error.as_deref().unwrap().contains("无需重启"));
    let (url, retry) = spawn_waiter(&flow, &origin, Duration::from_secs(10));
    release.send(()).unwrap();
    assert!(callback(&url).status().is_success());
    received.recv_timeout(Duration::from_secs(5)).unwrap();
    retry.join().unwrap(); server.join().unwrap();
    assert!(!flow.lock().unwrap().pending);
    assert!(flow.lock().unwrap().error.is_none());
    assert_eq!(read_tokens(&origin).unwrap().unwrap().user_id, "oauth-fixture");
}

#[cfg(windows)]
#[test]
fn late_token_response_cannot_overwrite_a_newer_login_or_its_state() {
    let (origin, server, received, release) = provider();
    let _cleanup = FixtureCredential(origin.clone());
    let flow = Arc::new(Mutex::new(Flow::default()));
    let (url, old_worker) = spawn_waiter(&flow, &origin, Duration::from_secs(10));
    let request = thread::spawn(move || callback(&url));
    received.recv_timeout(Duration::from_secs(5)).unwrap();
    let mut newer = FlowReservation::start(&flow, true).unwrap();
    commit_authorization(&flow, newer.generation, &Mutex::new(()), &fixture_tokens(&origin, "newer-fixture")).unwrap();
    newer.finish();
    release.send(()).unwrap();
    assert_eq!(request.join().unwrap().status(), reqwest::StatusCode::BAD_REQUEST);
    old_worker.join().unwrap(); server.join().unwrap();
    assert_eq!(read_tokens(&origin).unwrap().unwrap().user_id, "newer-fixture");
    assert!(!flow.lock().unwrap().pending);
    assert!(flow.lock().unwrap().error.is_none());
}

#[cfg(windows)]
#[test]
#[ignore = "Real elapsed-time registration regression; run explicitly (125 seconds)"]
fn first_registration_callback_after_two_minutes_still_connects() {
    let (origin, server, received, release) = provider();
    let _cleanup = FixtureCredential(origin.clone());
    let flow = Arc::new(Mutex::new(Flow::default()));
    let (url, worker) = spawn_waiter(&flow, &origin, AUTH_WAIT_TIMEOUT);
    thread::sleep(Duration::from_secs(125));
    assert!(flow.lock().unwrap().pending);
    release.send(()).unwrap();
    assert!(callback(&url).status().is_success());
    received.recv_timeout(Duration::from_secs(5)).unwrap();
    worker.join().unwrap(); server.join().unwrap();
    assert_eq!(read_tokens(&origin).unwrap().unwrap().user_id, "oauth-fixture");
    assert!(!flow.lock().unwrap().pending);
    assert!(flow.lock().unwrap().error.is_none());
}
