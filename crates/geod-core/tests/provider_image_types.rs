use geod_core::imagery::{fetch_preview_tile, HttpSource, ProxyRoute};
use image::{DynamicImage,ImageFormat,Rgb,RgbImage};
use std::{io::{Cursor,Read,Write},net::TcpListener,thread};

#[tokio::test]
async fn tianditu_jpg_alias_decodes_real_jpeg_but_does_not_accept_non_images() {
    for valid in [true,false] {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap();
        let source:HttpSource=serde_json::from_value(serde_json::json!({
            "id":"provider-type-fixture","name":"Provider media type fixture","attribution":"Synthetic pixels","license":"",
            "urlTemplate":format!("http://{address}/{{z}}/{{x}}/{{y}}"),"scheme":"XYZ","tileSize":256,"networkPolicy":"UserTrustedHttp","minIntervalMs":0
        })).unwrap();
        let worker=thread::spawn(move || {
            let (mut stream,_)=listener.accept().unwrap();let mut request=[0;8192];stream.read(&mut request).unwrap();
            let mut image=Cursor::new(Vec::new());
            DynamicImage::ImageRgb8(RgbImage::from_pixel(256,256,Rgb([12,100,140]))).write_to(&mut image,ImageFormat::Jpeg).unwrap();
            let bytes=if valid { image.into_inner() } else { b"{\"error\":\"not an image\"}".to_vec() };
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: image/jpg\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",bytes.len()).unwrap();stream.write_all(&bytes).unwrap();
        });
        let result=fetch_preview_tile(&source,2,2,1,ProxyRoute::Direct).await;
        if valid {assert_eq!(image::load_from_memory(&result.unwrap()).unwrap().width(),256);} else {assert!(result.is_err());}
        worker.join().unwrap();
    }
}
