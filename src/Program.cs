using System.Diagnostics;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);

builder.Configuration.AddEnvironmentVariables();

builder.Services.Configure<AppOptions>(builder.Configuration.GetSection("App"));
builder.Services.AddSingleton<IpmiService>();
builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Cookie.Name = "dell-fans-auth";
        options.Cookie.HttpOnly = true;
        options.Cookie.SameSite = SameSiteMode.Lax;
        options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
        options.SlidingExpiration = true;
        options.ExpireTimeSpan = TimeSpan.FromDays(7);
        options.Events = new CookieAuthenticationEvents
        {
            OnRedirectToLogin = context =>
            {
                if (context.Request.Path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase))
                {
                    context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                    return context.Response.WriteAsJsonAsync(new { error = "请先登录。" });
                }

                context.Response.Redirect("/");
                return Task.CompletedTask;
            },
            OnRedirectToAccessDenied = context =>
            {
                if (context.Request.Path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase))
                {
                    context.Response.StatusCode = StatusCodes.Status403Forbidden;
                    return context.Response.WriteAsJsonAsync(new { error = "没有权限访问。" });
                }

                context.Response.Redirect("/");
                return Task.CompletedTask;
            }
        };
    });
builder.Services.AddAuthorization();

var app = builder.Build();

app.Use(async (context, next) =>
{
    try
    {
        await next();
    }
    catch (Exception ex) when ((context.Request.Path.Value ?? string.Empty).StartsWith("/api", StringComparison.OrdinalIgnoreCase))
    {
        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
        await context.Response.WriteAsJsonAsync(new { error = ex.Message });
    }
});

app.UseDefaultFiles();
app.UseStaticFiles();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/api/health", () => Results.Ok(new { ok = true, service = "dell-fans-web" }));

app.MapGet("/api/auth/session", (HttpContext context, IOptions<AppOptions> options) =>
{
    var appOptions = options.Value;
    var isAuthenticated = context.User.Identity?.IsAuthenticated == true;
    return Results.Ok(new SessionResponse(
        isAuthenticated,
        isAuthenticated ? context.User.Identity?.Name ?? string.Empty : string.Empty,
        IsServerConfigured(appOptions),
        appOptions.IpmiHost));
});

app.MapPost("/api/auth/login", async (LoginRequest request, HttpContext context, IOptions<AppOptions> options) =>
{
    var appOptions = options.Value;
    if (string.IsNullOrWhiteSpace(appOptions.AdminUsername) || string.IsNullOrWhiteSpace(appOptions.AdminPassword))
    {
        return Results.Problem("服务端未配置登录账号或密码，请先设置环境变量。", statusCode: StatusCodes.Status500InternalServerError);
    }

    if (!string.Equals(request.Username?.Trim(), appOptions.AdminUsername, StringComparison.Ordinal) ||
        !string.Equals(request.Password, appOptions.AdminPassword, StringComparison.Ordinal))
    {
        return Results.Json(new { error = "账号或密码错误。" }, statusCode: StatusCodes.Status401Unauthorized);
    }

    var identity = new ClaimsIdentity(
        new[] { new Claim(ClaimTypes.Name, appOptions.AdminUsername) },
        CookieAuthenticationDefaults.AuthenticationScheme);

    await context.SignInAsync(
        CookieAuthenticationDefaults.AuthenticationScheme,
        new ClaimsPrincipal(identity),
        new AuthenticationProperties
        {
            IsPersistent = request.RememberMe,
            ExpiresUtc = DateTimeOffset.UtcNow.AddDays(request.RememberMe ? 14 : 1)
        });

    return Results.Ok(new SessionResponse(true, appOptions.AdminUsername, IsServerConfigured(appOptions), appOptions.IpmiHost));
});

var api = app.MapGroup("/api");
api.RequireAuthorization();

api.MapPost("/auth/logout", async (HttpContext context) =>
{
    await context.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
    return Results.Ok(new { message = "已退出登录。" });
});

api.MapGet("/system", (IOptions<AppOptions> options) =>
{
    var appOptions = options.Value;
    return Results.Ok(new
    {
        targetHost = appOptions.IpmiHost,
        configured = IsServerConfigured(appOptions),
        username = appOptions.IpmiUsername
    });
});

api.MapPost("/fans/manual", async (SetManualSpeedRequest request, IpmiService ipmi) =>
{
    if (request.Percent is < 0 or > 100)
    {
        return Results.BadRequest(new { error = "转速百分比必须在 0 到 100 之间。" });
    }

    var output = await ipmi.SetManualSpeedAsync(request.Percent);
    return Results.Ok(new { message = $"已设置手动风扇转速为 {request.Percent}%。", output });
});

api.MapPost("/fans/auto", async (IpmiService ipmi) =>
{
    var output = await ipmi.RestoreAutoAsync();
    return Results.Ok(new { message = "已恢复自动风扇控制。", output });
});

api.MapGet("/sensors", async (IpmiService ipmi) =>
{
    var sensors = await ipmi.GetSensorsAsync();
    return Results.Ok(sensors);
});

app.Run();

static bool IsServerConfigured(AppOptions options)
{
    return !string.IsNullOrWhiteSpace(options.AdminUsername) &&
           !string.IsNullOrWhiteSpace(options.AdminPassword) &&
           !string.IsNullOrWhiteSpace(options.IpmiHost) &&
           !string.IsNullOrWhiteSpace(options.IpmiUsername) &&
           !string.IsNullOrWhiteSpace(options.IpmiPassword);
}

sealed record AppOptions
{
    public string AdminUsername { get; init; } = "admin";
    public string AdminPassword { get; init; } = string.Empty;
    public string IpmiHost { get; init; } = string.Empty;
    public string IpmiUsername { get; init; } = "root";
    public string IpmiPassword { get; init; } = string.Empty;
    public string IpmiToolPath { get; init; } = "ipmitool";
}

sealed record FanControllerConfig(
    string Host,
    string Username,
    string Password,
    string IpmiToolPath);

sealed record LoginRequest(
    string Username,
    string Password,
    bool RememberMe);

sealed record SessionResponse(
    bool Authenticated,
    string Username,
    bool ServerConfigured,
    string TargetHost);

sealed record SetManualSpeedRequest(int Percent);

sealed record SensorReading(
    string Name,
    string Value,
    string Status,
    string Raw);

sealed class IpmiService
{
    private readonly IOptions<AppOptions> _options;

    public IpmiService(IOptions<AppOptions> options)
    {
        _options = options;
    }

    public async Task<string> SetManualSpeedAsync(int percent)
    {
        var config = GetValidatedConfig();

        await ExecuteAsync(
            config,
            "raw",
            "0x30",
            "0x30",
            "0x01",
            "0x00");

        return await ExecuteAsync(
            config,
            "raw",
            "0x30",
            "0x30",
            "0x02",
            "0xff",
            $"0x{percent:x2}");
    }

    public async Task<string> RestoreAutoAsync()
    {
        var config = GetValidatedConfig();
        return await ExecuteAsync(
            config,
            "raw",
            "0x30",
            "0x30",
            "0x01",
            "0x01");
    }

    public async Task<IReadOnlyList<SensorReading>> GetSensorsAsync()
    {
        var config = GetValidatedConfig();
        var output = await ExecuteAsync(config, "sensor");
        var result = new List<SensorReading>();

        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (string.IsNullOrWhiteSpace(line) || !line.Contains('|'))
            {
                continue;
            }

            var parts = line.Split('|', StringSplitOptions.TrimEntries);
            if (parts.Length < 3)
            {
                continue;
            }

            result.Add(new SensorReading(parts[0], parts[1], parts[2], line.Trim()));
        }

        return result;
    }

    private FanControllerConfig GetValidatedConfig()
    {
        var options = _options.Value;
        if (string.IsNullOrWhiteSpace(options.IpmiHost) ||
            string.IsNullOrWhiteSpace(options.IpmiUsername) ||
            string.IsNullOrWhiteSpace(options.IpmiPassword))
        {
            throw new InvalidOperationException("服务端未配置完整的 IPMI 参数，请先设置环境变量。");
        }

        return new FanControllerConfig(
            options.IpmiHost.Trim(),
            options.IpmiUsername.Trim(),
            options.IpmiPassword,
            string.IsNullOrWhiteSpace(options.IpmiToolPath) ? "ipmitool" : options.IpmiToolPath.Trim());
    }

    private static async Task<string> ExecuteAsync(FanControllerConfig config, params string[] commandArgs)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = config.IpmiToolPath,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        startInfo.ArgumentList.Add("-I");
        startInfo.ArgumentList.Add("lanplus");
        startInfo.ArgumentList.Add("-H");
        startInfo.ArgumentList.Add(config.Host);
        startInfo.ArgumentList.Add("-U");
        startInfo.ArgumentList.Add(config.Username);
        startInfo.ArgumentList.Add("-P");
        startInfo.ArgumentList.Add(config.Password);

        foreach (var item in commandArgs)
        {
            startInfo.ArgumentList.Add(item);
        }

        using var process = new Process { StartInfo = startInfo };

        try
        {
            process.Start();
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException(
                $"启动 ipmitool 失败，请检查容器内是否已安装该命令，或路径是否正确：{config.IpmiToolPath}。详细信息：{ex.Message}",
                ex);
        }

        var stdout = await process.StandardOutput.ReadToEndAsync();
        var stderr = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();

        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"ipmitool 执行失败，退出码 {process.ExitCode}。错误信息：{stderr.Trim()}");
        }

        return string.IsNullOrWhiteSpace(stdout) ? stderr.Trim() : stdout.Trim();
    }
}
