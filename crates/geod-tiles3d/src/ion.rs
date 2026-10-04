//! Cesium Ion endpoint resolution. Tokens and the returned signed URL stay in memory.
use reqwest::{Client, Url};
use serde::Deserialize;
use std::{collections::BTreeMap, time::Duration};

pub struct ResolvedEndpoint {
    pub tileset_url: String,
    pub headers: BTreeMap<String, String>,
    pub inherit_query: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    #[serde(rename = "type")]
    kind: String,
    url: Option<String>,
    access_token: Option<String>,
    options: Option<Options>,
    #[serde(default)]
    attributions: Vec<Attribution>,
}
#[derive(Deserialize)]
struct Attribution { html: String }
#[derive(Deserialize)]
struct Options {
    url: Option<String>,
}

pub async fn resolve(
    asset_id: u64,
    token: &str,
    proxy: Option<&str>,
) -> Result<ResolvedEndpoint, String> {
    let client = client(proxy)?;
    resolve_at(&client, "https://api.cesium.com", asset_id, token).await
}

pub struct TerrainEndpoint {
    pub layer_url: String,
    pub headers: BTreeMap<String, String>,
    pub credits: Vec<String>,
}
pub async fn resolve_terrain(asset_id: u64, token: &str, proxy: Option<&str>) -> Result<TerrainEndpoint, String> {
    let client = client(proxy)?;
    let (endpoint, credits) = resolve_kind_at(&client, "https://api.cesium.com", asset_id, token, "TERRAIN").await?;
    Ok(TerrainEndpoint { layer_url: endpoint.tileset_url, headers: endpoint.headers, credits })
}
fn client(proxy: Option<&str>) -> Result<Client, String> {
    let mut builder = Client::builder()
        .gzip(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(proxy) = proxy {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| "Invalid proxy")?);
    }
    builder
        .build()
        .map_err(|_| "Cannot initialize Cesium Ion connection".into())
}

async fn resolve_at(
    client: &Client,
    api: &str,
    asset_id: u64,
    token: &str,
) -> Result<ResolvedEndpoint, String> {
    Ok(resolve_kind_at(client, api, asset_id, token, "3DTILES").await?.0)
}
async fn resolve_kind_at(client: &Client, api: &str, asset_id: u64, token: &str, expected: &str) -> Result<(ResolvedEndpoint, Vec<String>), String> {
    if asset_id == 0
        || token.trim().is_empty()
        || token.len() > 8192
        || token.chars().any(char::is_control)
    {
        return Err("Cesium Ion requires a valid asset ID and access token".into());
    }
    // Never follow a redirect with the user's Ion account token.
    let mut response = client
        .get(format!("{api}/v1/assets/{asset_id}/endpoint"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Cesium Ion connection failed")?;
    if !response.status().is_success() {
        return Err(format!(
            "Cesium Ion returned HTTP {}",
            response.status().as_u16()
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Cannot read Cesium Ion endpoint")?
    {
        if body.len() + chunk.len() > 1024 * 1024 {
            return Err("Cesium Ion endpoint response is too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    let endpoint: Endpoint =
        serde_json::from_slice(&body).map_err(|_| "Invalid Cesium Ion endpoint response")?;
    if endpoint.kind != expected {
        return Err(if expected == "TERRAIN" { "This Cesium Ion asset is not a terrain dataset" } else { "This Cesium Ion asset is not a 3D Tiles dataset" }.into());
    }
    let value = endpoint
        .url
        .or_else(|| endpoint.options.and_then(|o| o.url))
        .ok_or("Cesium Ion returned no tileset URL")?;
    let mut url = Url::parse(&value).map_err(|_| "Cesium Ion returned an invalid tileset URL")?;
    super::validate_url(&url)?;
    if api.starts_with("https:") && url.scheme() != "https" {
        return Err("Cesium Ion returned an insecure endpoint".into());
    }
    if !url.path().to_ascii_lowercase().ends_with(".json") {
        url.set_path(&format!(
            "{}/{}",
            url.path().trim_end_matches('/'), if expected == "TERRAIN" { "layer.json" } else { "tileset.json" }
        ));
    }
    let mut headers = BTreeMap::new();
    if let Some(token) = endpoint.access_token {
        reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "Invalid Cesium Ion endpoint token")?;
        headers.insert("Authorization".into(), format!("Bearer {token}"));
    }
    Ok((ResolvedEndpoint {
        tileset_url: url.to_string(),
        headers,
        inherit_query: true,
    }, endpoint.attributions.into_iter().map(|c| c.html).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn terrain_asset_resolution_requires_the_actual_kind_and_uses_the_endpoint_token(){
        let server=tiny_http::Server::http("127.0.0.1:0").unwrap();let api=format!("http://{}",server.server_addr());let value=api.clone();
        let worker=std::thread::spawn(move||{for kind in ["TERRAIN","3DTILES"]{let request=server.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();assert_eq!(request.url(),"/v1/assets/1/endpoint");assert!(request.headers().iter().any(|h|h.field.equiv("Authorization")&&h.value.as_str()=="Bearer fixture-account"));request.respond(tiny_http::Response::from_string(serde_json::json!({"type":kind,"url":format!("{value}/terrain?v=2"),"accessToken":"fixture-endpoint","attributions":[{"html":"Terrain source"}]}).to_string())).unwrap();}});
        let client=Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let (endpoint,credits)=resolve_kind_at(&client,&api,1,"fixture-account","TERRAIN").await.unwrap();assert!(endpoint.tileset_url.ends_with("/terrain/layer.json?v=2"));assert_eq!(endpoint.headers["Authorization"],"Bearer fixture-endpoint");assert_eq!(credits,vec!["Terrain source"]);
        assert_eq!(resolve_kind_at(&client,&api,1,"fixture-account","TERRAIN").await.err().unwrap(),"This Cesium Ion asset is not a terrain dataset");worker.join().unwrap();
    }
    #[tokio::test]
    async fn ion_account_token_and_endpoint_token_are_separate_and_bundle_is_secret_free() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", server.server_addr());
        let origin2 = origin.clone();
        let worker = std::thread::spawn(move || {
            for index in 0..4 {
                let request = server
                    .recv_timeout(Duration::from_secs(10))
                    .unwrap()
                    .unwrap();
                let auth = request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Authorization"))
                    .unwrap()
                    .value
                    .as_str();
                if index == 0 {
                    assert_eq!(request.url(), "/v1/assets/7/endpoint");
                    assert_eq!(auth, "Bearer fixture-account-token");
                    request.respond(tiny_http::Response::from_string(serde_json::json!({"type":"3DTILES","url":format!("{origin2}/data?v=2"),"accessToken":"fixture-endpoint-token"}).to_string())).unwrap();
                } else {
                    assert_eq!(auth, "Bearer fixture-endpoint-token");
                    assert_eq!(
                        request
                            .headers()
                            .iter()
                            .find(|h| h.field.equiv("Referer"))
                            .unwrap()
                            .value
                            .as_str(),
                        "https://viewer.fixture/"
                    );
                    assert!(request.url().contains("v=2"));
                    if index == 1 {
                        assert_eq!(request.url(), "/data/tileset.json?v=2");
                        request.respond(tiny_http::Response::from_string(r#"{"asset":{"version":"1.1"},"geometricError":0,"root":{"boundingVolume":{"region":[0,0,0.1,0.1,0,10]},"geometricError":0,"content":{"uri":"nested.json?session=fixture-session"}}}"#)).unwrap();
                    } else if index == 2 {
                        assert!(request.url().contains("session=fixture-session"));
                        request.respond(tiny_http::Response::from_string(r#"{"asset":{"version":"1.1"},"geometricError":0,"root":{"boundingVolume":{"region":[0,0,0.1,0.1,0,10]},"geometricError":0,"content":{"uri":"content.gltf"}}}"#)).unwrap();
                    } else {
                        assert!(request.url().contains("session=fixture-session"));
                        request
                            .respond(tiny_http::Response::from_string(
                                r#"{"asset":{"version":"2.0"},"scenes":[{"nodes":[]}],"scene":0}"#,
                            ))
                            .unwrap();
                    }
                }
            }
        });
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let endpoint = resolve_at(&client, &origin, 7, "fixture-account-token")
            .await
            .unwrap();
        let temp = tempfile::tempdir().unwrap();
        let mut request =
            super::super::DownloadRequest::new(endpoint.tileset_url, temp.path().join("bundle"));
        request.headers = endpoint.headers;
        request.inherit_query = endpoint.inherit_query;
        request
            .headers
            .insert("Referer".into(), "https://viewer.fixture/".into());
        request.source_fingerprint = Some("stable-connection-revision".into());
        let bundle =
            super::super::download(request, super::super::CancellationToken::new(), |_| {})
                .await
                .unwrap();
        assert_eq!(bundle.source_fingerprint, "stable-connection-revision");
        for file in ["manifest.json", "tileset.json"] {
            let text = std::fs::read_to_string(temp.path().join("bundle").join(file)).unwrap();
            assert!(!text.contains("fixture-"));
            assert!(!text.contains("Bearer"));
        }
        worker.join().unwrap();
    }
    #[tokio::test]
    async fn ion_redirect_is_not_followed_and_error_does_not_echo_response_secrets() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", server.server_addr());
        let worker = std::thread::spawn(move || {
            let request = server.recv().unwrap();
            request
                .respond(
                    tiny_http::Response::from_string("fixture-account-token")
                        .with_status_code(302)
                        .with_header(
                            tiny_http::Header::from_bytes(
                                "Location",
                                "https://example.invalid/?token=fixture-account-token",
                            )
                            .unwrap(),
                        ),
                )
                .unwrap();
        });
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let error = resolve_at(&client, &origin, 7, "fixture-account-token")
            .await
            .err()
            .unwrap();
        assert_eq!(error, "Cesium Ion returned HTTP 302");
        worker.join().unwrap();
    }
    #[tokio::test]
    async fn custom_headers_are_not_sent_to_external_resource_origins() {
        let root = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let outside = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let source = format!("http://{}/tileset.json", root.server_addr());
        let external = format!("http://{}/content.gltf", outside.server_addr());
        let root_worker = std::thread::spawn(move || {
            let request = root.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();
            assert!(
                request
                    .headers()
                    .iter()
                    .any(|h| h.field.equiv("X-API-Key")
                        && h.value.as_str() == "fixture-direct-secret")
            );
            assert!(request.headers().iter().any(|h| h.field.equiv("Referer")));
            request.respond(tiny_http::Response::from_string(serde_json::json!({"asset":{"version":"1.1"},"geometricError":0,"root":{"boundingVolume":{"region":[0,0,0.1,0.1,0,10]},"geometricError":0,"content":{"uri":external}}}).to_string())).unwrap();
        });
        let external_worker = std::thread::spawn(move || {
            let request = outside
                .recv_timeout(Duration::from_secs(10))
                .unwrap()
                .unwrap();
            assert!(!request
                .headers()
                .iter()
                .any(|h| h.field.equiv("X-API-Key") || h.field.equiv("Referer")));
            request
                .respond(tiny_http::Response::from_string(
                    r#"{"asset":{"version":"2.0"},"scenes":[{"nodes":[]}],"scene":0}"#,
                ))
                .unwrap();
        });
        let temp = tempfile::tempdir().unwrap();
        let mut request = crate::DownloadRequest::new(source, temp.path().join("out"));
        request.headers = BTreeMap::from([
            ("X-API-Key".into(), "fixture-direct-secret".into()),
            ("Referer".into(), "https://viewer.fixture/".into()),
        ]);
        assert!(!format!("{request:?}").contains("fixture-direct-secret"));
        crate::download(request, crate::CancellationToken::new(), |_| {})
            .await
            .unwrap();
        root_worker.join().unwrap();
        external_worker.join().unwrap();
    }
}
