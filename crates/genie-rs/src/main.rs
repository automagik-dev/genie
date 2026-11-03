fn main() {
    let args: Vec<String> = std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();
    let code = genie_rs::run(&args, &mut std::io::stdout().lock(), &mut std::io::stderr().lock());
    std::process::exit(code);
}
